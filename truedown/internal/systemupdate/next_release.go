package systemupdate

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed next-release.json
var reviewedNextReleaseJSON []byte

type nextReleasePolicy struct {
	Version string            `json:"version"`
	Windows map[string]string `json:"windows"`
}

func reviewedNextRelease() (nextReleasePolicy, error) {
	var policy nextReleasePolicy
	if err := json.Unmarshal(reviewedNextReleaseJSON, &policy); err != nil {
		return policy, fmt.Errorf("read reviewed NEXT release: %w", err)
	}
	if !canonicalVersionPattern.MatchString(policy.Version) || len(policy.Windows) != 2 {
		return policy, fmt.Errorf("invalid reviewed NEXT release")
	}
	for _, architecture := range []string{"amd64", "arm64"} {
		if normalizeSHA256(policy.Windows[architecture]) == "" {
			return policy, fmt.Errorf("invalid reviewed NEXT %s digest", architecture)
		}
	}
	return policy, nil
}
