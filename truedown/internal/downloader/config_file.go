package downloader

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"truedown/internal/safefile"
)

func readStrictJSONFile(path string, maximum int64, target any) error {
	data, err := safefile.ReadFile(path, maximum)
	if err != nil {
		return err
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 || data[0] != '{' {
		return fmt.Errorf("file must contain one JSON object")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("file must contain one JSON object")
	}
	return nil
}

func writeConfigFile(path string, data []byte) error {
	return safefile.WriteFile(path, data, 0600)
}
