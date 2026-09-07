// Package buildinfo supplies the same release identity to both Go sidecars.
package buildinfo

import "truedown/internal/protocol"

// Values are set together by the native build preparation step.
var (
	Version     = "dev"
	BuildNumber = "0"
	Commit      = "unknown"
)

func Current() protocol.Info {
	return protocol.Info{Product: protocol.Product, ProtocolVersion: protocol.Version,
		Version: Version, BuildNumber: BuildNumber, Commit: Commit, Mode: "serve"}
}
