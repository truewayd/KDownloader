// Package protocol defines the small client/core compatibility boundary.
// It deliberately has no dependency on the downloader or its database.
package protocol

const Product = "TrueDown"
const Version = 1

type Info struct {
	ProductVersion  string `json:"productVersion,omitempty"`
	Product         string `json:"product"`
	ProtocolVersion int    `json:"protocolVersion"`
	Version         string `json:"version"`
	BuildNumber     string `json:"buildNumber"`
	Commit          string `json:"commit"`
	Mode            string `json:"mode"`
}
