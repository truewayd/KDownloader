//go:build windows

package app

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var coreScope struct {
	once sync.Once
	job  windows.Handle
	err  error
}

// The console core joins its own kill-on-close job before spawning an engine.
// Only this process holds the noninheritable job handle. Process death closes
// it in the kernel, including forced termination, with no spawn/assignment race.
// Keep it until process exit: closing it explicitly would terminate this core.
// Native update helpers are dispatched before this scope is established.
func protectCoreProcess() error {
	coreScope.once.Do(func() {
		job, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			coreScope.err = err
			return
		}
		limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK
		_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
		if err == nil {
			err = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
		}
		if err != nil {
			windows.CloseHandle(job)
			coreScope.err = err
			return
		}
		coreScope.job = job
	})
	return coreScope.err
}
