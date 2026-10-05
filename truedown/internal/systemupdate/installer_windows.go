package systemupdate

import (
	"os/exec"
	"syscall"
)

func configureInstallerProcess(command *exec.Cmd, directory string) {
	configureHiddenProcess(command)
	// NSIS /D is a raw final argument: Go's normal space quoting is not accepted.
	command.SysProcAttr.CmdLine = syscall.EscapeArg(command.Path) + " /S /UPDATE /TRUEDOWN-STAGE /D=" + directory
}
