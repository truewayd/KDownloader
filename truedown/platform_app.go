package main

import "sync"

type platformAction uint8

const (
	platformOpenDashboard platformAction = iota + 1
	platformOpenDownloads
	platformOpenLog
	platformExit
)

type platformApp struct {
	actions   <-chan platformAction
	closeOnce sync.Once
	closeFn   func()
}

func (app *platformApp) Actions() <-chan platformAction {
	if app == nil {
		return nil
	}
	return app.actions
}

func (app *platformApp) Close() {
	if app == nil || app.closeFn == nil {
		return
	}
	app.closeOnce.Do(app.closeFn)
}
