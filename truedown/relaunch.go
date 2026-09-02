package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const engineRelaunchEnv = "TRUEDOWN_ENGINE_RELAUNCH"

func launchEngineRelaunch(args []string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve TrueDown executable for reload: %w", err)
	}
	command := exec.Command(executable, append([]string(nil), args...)...)
	command.Env = appendWithoutEnvironment(os.Environ(), engineRelaunchEnv)
	command.Env = append(command.Env, engineRelaunchEnv+"="+strconv.Itoa(engineRelaunchAttempt()+1))
	configureRelaunchProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start reloaded TrueDown: %w", err)
	}
	return command.Process.Release()
}

func isEngineRelaunch() bool {
	return engineRelaunchAttempt() > 0
}

func engineRelaunchAttempt() int {
	attempt, err := strconv.Atoi(strings.TrimSpace(os.Getenv(engineRelaunchEnv)))
	if err != nil || attempt < 0 || attempt > 100 {
		return 0
	}
	return attempt
}

func resetEngineRelaunchCircuitAfterHealthyPeriod() {
	if !isEngineRelaunch() {
		return
	}
	go func() {
		timer := time.NewTimer(2 * time.Minute)
		defer timer.Stop()
		<-timer.C
		_ = os.Unsetenv(engineRelaunchEnv)
	}()
}

func appendWithoutEnvironment(environment []string, name string) []string {
	prefix := strings.ToUpper(name) + "="
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		if strings.HasPrefix(strings.ToUpper(entry), prefix) {
			continue
		}
		result = append(result, entry)
	}
	return result
}
