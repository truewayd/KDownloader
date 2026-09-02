package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"truedown/internal/downloader"
	"truedown/internal/systemupdate"
)

var errStaleManagerRuntime = errors.New("download manager runtime is no longer active")

type drainingHandler struct {
	mu       sync.Mutex
	handler  http.Handler
	draining bool
	active   int
	drained  chan struct{}
}

func newDrainingHandler(handler http.Handler) *drainingHandler {
	return &drainingHandler{handler: handler, drained: make(chan struct{})}
}

func (handler *drainingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	handler.mu.Lock()
	if handler.draining {
		handler.mu.Unlock()
		w.Header().Set("Retry-After", "2")
		http.Error(w, "TrueDown is switching the download engine; retry shortly", http.StatusServiceUnavailable)
		return
	}
	handler.active++
	delegate := handler.handler
	handler.mu.Unlock()

	defer func() {
		handler.mu.Lock()
		handler.active--
		if handler.draining && handler.active == 0 {
			select {
			case <-handler.drained:
			default:
				close(handler.drained)
			}
		}
		handler.mu.Unlock()
	}()
	delegate.ServeHTTP(w, r)
}

func (handler *drainingHandler) quiesce(ctx context.Context) error {
	handler.mu.Lock()
	if !handler.draining {
		handler.draining = true
		handler.drained = make(chan struct{})
	}
	drained := handler.drained
	if handler.active == 0 {
		select {
		case <-drained:
		default:
			close(drained)
		}
	}
	handler.mu.Unlock()

	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (handler *drainingHandler) resume() {
	handler.mu.Lock()
	handler.draining = false
	handler.mu.Unlock()
}

type managerRuntime struct {
	manager *downloader.Manager
	spec    systemupdate.EngineSpec
	handler *drainingHandler
}

type managerHost struct {
	mu       sync.RWMutex
	switchMu sync.Mutex
	current  *managerRuntime
	build    func(systemupdate.EngineSpec) (*downloader.Manager, error)
	routes   func(*downloader.Manager) http.Handler
	launch   func(systemupdate.EngineSpec) (*downloader.Manager, error)
}

func (host *managerHost) configure(
	manager *downloader.Manager,
	spec systemupdate.EngineSpec,
	build func(systemupdate.EngineSpec) (*downloader.Manager, error),
	routes func(*downloader.Manager) http.Handler,
) {
	host.mu.Lock()
	defer host.mu.Unlock()
	host.build = build
	host.routes = routes
	host.current = &managerRuntime{manager: manager, spec: spec, handler: newDrainingHandler(routes(manager))}
}

func (host *managerHost) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host.mu.RLock()
	current := host.current
	host.mu.RUnlock()
	if current == nil {
		w.Header().Set("Retry-After", "3")
		http.Error(w, "TrueDown download engine is unavailable; reloading", http.StatusServiceUnavailable)
		return
	}
	current.handler.ServeHTTP(w, r)
}

func (host *managerHost) taskCount(status downloader.Status) int {
	host.mu.RLock()
	current := host.current
	host.mu.RUnlock()
	if current == nil {
		return 0
	}
	return current.manager.TaskCountByStatus(status)
}

func (host *managerHost) hasActiveBitTorrent() bool {
	host.mu.RLock()
	current := host.current
	host.mu.RUnlock()
	return current != nil && current.manager.HasActiveBitTorrent()
}

type engineTransitionResult struct {
	Active      systemupdate.EngineSpec
	TargetLive  bool
	RolledBack  bool
	Unavailable bool
}

func (host *managerHost) transition(
	source *downloader.Manager,
	target systemupdate.EngineSpec,
	rollback *systemupdate.EngineSpec,
	attempts int,
) (engineTransitionResult, error) {
	host.switchMu.Lock()
	defer host.switchMu.Unlock()
	if attempts < 1 {
		attempts = 1
	}

	host.mu.RLock()
	current := host.current
	host.mu.RUnlock()
	if current == nil || (source != nil && current.manager != source) {
		return engineTransitionResult{}, errStaleManagerRuntime
	}

	drainContext, cancelDrain := context.WithTimeout(context.Background(), 30*time.Second)
	err := current.handler.quiesce(drainContext)
	cancelDrain()
	if err != nil {
		current.handler.resume()
		return engineTransitionResult{Active: current.spec}, fmt.Errorf("wait for active TrueDown requests before switching engines: %w", err)
	}
	if target.Kind == systemupdate.EngineStable && current.spec.Kind == systemupdate.EngineNext &&
		current.manager.HasActiveBitTorrent() {
		current.handler.resume()
		return engineTransitionResult{Active: current.spec},
			fmt.Errorf("finish or remove all BitTorrent tasks before switching to the stable aria2 engine")
	}

	current.manager.Stop()
	var startErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		candidate, err := host.start(target)
		if err == nil {
			host.publish(candidate, target)
			return engineTransitionResult{Active: target, TargetLive: true}, nil
		}
		startErr = err
		log.Printf("start download engine %s attempt %d/%d: %v", target.Kind, attempt, attempts, err)
		if attempt < attempts {
			delay := time.Duration(attempt*attempt) * time.Second
			time.Sleep(delay)
		}
	}

	if rollback != nil && !sameRuntimeEngine(target, *rollback) {
		candidate, rollbackErr := host.start(*rollback)
		if rollbackErr == nil {
			host.publish(candidate, *rollback)
			return engineTransitionResult{Active: *rollback, RolledBack: true},
				fmt.Errorf("start selected download engine: %w; restored %s", startErr, rollback.Kind)
		}
		startErr = errors.Join(startErr, fmt.Errorf("restore previous download engine: %w", rollbackErr))
	}

	host.mu.Lock()
	if host.current == current {
		host.current = nil
	}
	host.mu.Unlock()
	return engineTransitionResult{Unavailable: true}, startErr
}

func (host *managerHost) start(spec systemupdate.EngineSpec) (*downloader.Manager, error) {
	if host.launch != nil {
		return host.launch(spec)
	}
	manager, err := host.build(spec)
	if err != nil {
		return nil, err
	}
	if err := manager.Start(); err != nil {
		manager.Stop()
		return nil, err
	}
	return manager, nil
}

func (host *managerHost) publish(manager *downloader.Manager, spec systemupdate.EngineSpec) {
	host.mu.Lock()
	host.current = &managerRuntime{
		manager: manager,
		spec:    spec,
		handler: newDrainingHandler(host.routes(manager)),
	}
	host.mu.Unlock()
}

func (host *managerHost) stop() {
	host.switchMu.Lock()
	defer host.switchMu.Unlock()
	host.mu.Lock()
	current := host.current
	host.current = nil
	host.mu.Unlock()
	if current == nil {
		return
	}
	drainContext, cancelDrain := context.WithTimeout(context.Background(), 5*time.Second)
	_ = current.handler.quiesce(drainContext)
	cancelDrain()
	current.manager.Stop()
}

func sameRuntimeEngine(left, right systemupdate.EngineSpec) bool {
	return left.Kind == right.Kind && left.Version == right.Version && left.File == right.File &&
		strings.EqualFold(left.Path, right.Path)
}

type engineController struct {
	updates *systemupdate.Manager
	host    *managerHost
	reload  func() error

	selectionMu sync.Mutex
	mu          sync.RWMutex
	phase       string
	lastError   string
	pendingExit *engineExitNotice
}

type engineExitNotice struct {
	source *downloader.Manager
	cause  error
}

func newEngineController(updates *systemupdate.Manager, host *managerHost, reload func() error) *engineController {
	return &engineController{updates: updates, host: host, reload: reload}
}

func (controller *engineController) Snapshot() systemupdate.Snapshot {
	snapshot := controller.updates.Snapshot()
	controller.mu.RLock()
	defer controller.mu.RUnlock()
	if controller.phase != "" {
		snapshot.Busy = controller.phase
	}
	if controller.lastError != "" {
		snapshot.Error = controller.lastError
	}
	return snapshot
}

func (controller *engineController) SetSettings(settings systemupdate.Settings) (systemupdate.Snapshot, error) {
	snapshot, err := controller.updates.SetSettings(settings)
	return controller.overlay(snapshot), err
}

func (controller *engineController) UpdateTrueDown(ctx context.Context) (systemupdate.Snapshot, error) {
	snapshot, err := controller.updates.UpdateTrueDown(ctx)
	return controller.overlay(snapshot), err
}

func (controller *engineController) InstallNext(ctx context.Context) (systemupdate.Snapshot, error) {
	controller.selectionMu.Lock()
	defer controller.selectionMu.Unlock()
	if controller.transitionActive() {
		return controller.Snapshot(), fmt.Errorf("download engine transition is still running")
	}
	_, err := controller.updates.InstallNext(ctx)
	if err != nil {
		return controller.Snapshot(), err
	}
	if controller.updates.Snapshot().Engine.Preference == systemupdate.EngineNext {
		if err := controller.schedulePreferredSwitchLocked("engine-switch"); err != nil {
			controller.updates.RecordEngineError(err)
			return controller.Snapshot(), err
		}
	}
	return controller.Snapshot(), nil
}

func (controller *engineController) SelectEngine(engine string) (systemupdate.Snapshot, error) {
	controller.selectionMu.Lock()
	defer controller.selectionMu.Unlock()
	if controller.transitionActive() {
		return controller.Snapshot(), fmt.Errorf("download engine transition is still running")
	}
	normalizedEngine := strings.ToLower(strings.TrimSpace(engine))
	if normalizedEngine == systemupdate.EngineStable && controller.updates.ActiveEngine().Kind == systemupdate.EngineNext &&
		controller.host.hasActiveBitTorrent() {
		return controller.Snapshot(), fmt.Errorf("finish or remove all BitTorrent tasks before switching to the stable aria2 engine")
	}
	if _, err := controller.updates.SelectEngine(normalizedEngine); err != nil {
		return controller.Snapshot(), err
	}
	if err := controller.schedulePreferredSwitchLocked("engine-switch"); err != nil {
		controller.updates.RecordEngineError(err)
		return controller.Snapshot(), err
	}
	return controller.Snapshot(), nil
}

func (controller *engineController) RequestRestart() error {
	if controller.transitionActive() {
		return fmt.Errorf("download engine transition is still running")
	}
	return controller.updates.RequestRestart()
}

func (controller *engineController) schedulePreferredSwitchLocked(phase string) error {
	target, err := controller.updates.PreferredEngine()
	if err != nil {
		return err
	}
	active := controller.updates.ActiveEngine()
	if sameRuntimeEngine(target, active) {
		return nil
	}
	controller.setTransition(phase, "")
	go controller.runPlannedSwitch(target, active)
	return nil
}

func (controller *engineController) runPlannedSwitch(target, previous systemupdate.EngineSpec) {
	result, err := controller.host.transition(nil, target, &previous, 1)
	if result.TargetLive {
		if _, activateErr := controller.updates.ActivateEngine(target); activateErr != nil {
			err = errors.Join(err, activateErr)
			controller.updates.RecordEngineError(err)
			controller.requestReload(err)
			return
		}
	}
	if err != nil {
		if !result.Unavailable && result.Active.Kind != "" {
			if _, preferenceErr := controller.updates.SelectEngine(result.Active.Kind); preferenceErr != nil {
				err = errors.Join(err, fmt.Errorf("restore previous engine preference: %w", preferenceErr))
			}
		}
		controller.updates.RecordEngineError(err)
	}
	if result.Unavailable {
		controller.requestReload(err)
		return
	}
	controller.finishTransition(err)
}

func (controller *engineController) recover(source *downloader.Manager, cause error) {
	controller.selectionMu.Lock()
	defer controller.selectionMu.Unlock()
	if controller.transitionActive() {
		controller.mu.Lock()
		if controller.phase != "engine-reload" {
			controller.pendingExit = &engineExitNotice{source: source, cause: cause}
		}
		controller.mu.Unlock()
		return
	}
	target := controller.updates.ActiveEngine()
	if cause == nil {
		cause = errors.New("download engine process exited without an error status")
	}
	controller.setTransition("engine-recovery", "")
	go func() {
		result, err := controller.host.transition(source, target, nil, 3)
		if errors.Is(err, errStaleManagerRuntime) {
			controller.finishTransition(nil)
			return
		}
		if err == nil && result.TargetLive {
			controller.updates.RecordEngineError(nil)
			controller.finishTransition(nil)
			return
		}
		recoveryErr := errors.Join(fmt.Errorf("download engine exited unexpectedly: %w", cause), err)
		controller.updates.RecordEngineError(recoveryErr)
		controller.requestReload(recoveryErr)
	}()
}

func (controller *engineController) requestReload(reason error) {
	controller.mu.Lock()
	controller.phase = "engine-reload"
	controller.lastError = errorString(reason)
	controller.pendingExit = nil
	controller.mu.Unlock()
	if controller.reload == nil {
		controller.finishTransition(reason)
		return
	}
	if err := controller.reload(); err != nil {
		controller.finishTransition(errors.Join(reason, err))
	}
}

func (controller *engineController) transitionActive() bool {
	controller.mu.RLock()
	defer controller.mu.RUnlock()
	return controller.phase != ""
}

func (controller *engineController) setTransition(phase, lastError string) {
	controller.mu.Lock()
	controller.phase = phase
	controller.lastError = lastError
	controller.mu.Unlock()
}

func (controller *engineController) finishTransition(err error) {
	controller.mu.Lock()
	controller.phase = ""
	controller.lastError = errorString(err)
	pending := controller.pendingExit
	controller.pendingExit = nil
	controller.mu.Unlock()
	if pending != nil {
		go controller.recover(pending.source, pending.cause)
	}
}

func (controller *engineController) overlay(snapshot systemupdate.Snapshot) systemupdate.Snapshot {
	controller.mu.RLock()
	defer controller.mu.RUnlock()
	if controller.phase != "" {
		snapshot.Busy = controller.phase
	}
	if controller.lastError != "" {
		snapshot.Error = controller.lastError
	}
	return snapshot
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
