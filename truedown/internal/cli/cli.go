// Package cli implements the console client without linking the download engine.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"unicode"

	"truedown/internal/buildinfo"
	"truedown/internal/client"
	"truedown/internal/profile"
	"truedown/internal/protocol"
	"truedown/internal/safefile"
)

const Usage = `truedown [--endpoint URL] [--data-dir PATH] [--json] COMMAND [OPTIONS]

  status                         Show core identity and queue counts.
  paths                          Show resolved local profile without starting it.
  list [--status STATE] [--search TEXT] [--limit 100] [--offset 0]
  add [--name NAME] [--folder PATH] URL
  pause ID... | resume ID... | retry ID...
  exit                           Request a graceful core exit.

Start the service with truedown-core; use TrueDown ui for the browser dashboard.
Global flags precede COMMAND. Command flags precede positional arguments.
Credentials: TRUEDOWN_API_TOKEN, or truedown.token in an explicit --data-dir.
Exit codes: 0 success, 1 connection/API failure, 2 usage, 3 partial task failure.
`

type task struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Status   string `json:"status"`
	Progress string `json:"progress"`
}
type page struct {
	Tasks   []task         `json:"tasks"`
	Summary map[string]int `json:"summary"`
	Total   int            `json:"total"`
}
type operation struct {
	Succeeded []int64 `json:"succeeded"`
	Failed    []struct {
		ID    int64  `json:"id"`
		Error string `json:"error"`
	} `json:"failed"`
}

func flags(name string) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(io.Discard)
	return f
}

func Run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	global := flags("truedown")
	endpoint := "http://127.0.0.1:15151"
	if addr := os.Getenv("TRUEDOWN_ADDR"); addr != "" {
		scheme := "http://"
		if os.Getenv("TRUEDOWN_TLS_CERT") != "" {
			scheme = "https://"
		}
		endpoint = scheme + addr
	}
	var dataDir string
	var jsonOutput, help bool
	global.StringVar(&endpoint, "endpoint", endpoint, "core origin")
	global.StringVar(&dataDir, "data-dir", os.Getenv("TRUEDOWN_DATA_DIR"), "credential directory")
	global.BoolVar(&jsonOutput, "json", false, "JSON output")
	global.BoolVar(&help, "help", false, "help")
	if err := global.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fmt.Fprint(stdout, Usage)
			return 0
		}
		fmt.Fprintln(stderr, clean(err.Error()))
		return 2
	}
	if help || global.NArg() == 0 {
		fmt.Fprint(stdout, Usage)
		return 0
	}
	command, rest := global.Arg(0), global.Args()[1:]
	if command == "paths" {
		if len(rest) != 0 {
			return usageError(stderr)
		}
		executable, err := os.Executable()
		if err != nil {
			fmt.Fprintln(stderr, "cannot resolve launcher directory")
			return 1
		}
		location, err := profile.Resolve(dataDir, filepath.Dir(executable))
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if jsonOutput {
			_ = json.NewEncoder(stdout).Encode(struct {
				profile.Location
				Build protocol.Info `json:"build"`
			}{location, buildinfo.Current()})
		} else {
			fmt.Fprintf(stdout, "Profile: %s\nSource: %s\nLayout: %d\nConfig: %s\nData: %s\nState: %s\nLogs: %s\nCache: %s\n", clean(location.DataDirectory), location.Source, location.LayoutVersion, clean(location.Paths.Config), clean(location.Paths.Data), clean(location.Paths.State), clean(location.Paths.Logs), clean(location.Paths.Cache))
		}
		return 0
	}
	method, path := http.MethodGet, ""
	var body any
	switch command {
	case "status":
		if len(rest) != 0 {
			return usageError(stderr)
		}
		path = "/tasks?limit=1"
	case "list":
		f := flags("list")
		status := f.String("status", "", "task status")
		search := f.String("search", "", "filename or link")
		limit := f.Int("limit", 100, "page size")
		offset := f.Int("offset", 0, "page offset")
		if f.Parse(rest) != nil || f.NArg() != 0 || *limit < 1 || *limit > 200 || *offset < 0 || *offset > 10000000 || len(*search) > 512 {
			return usageError(stderr)
		}
		if *status != "" && *status != "queued" && *status != "downloading" && *status != "paused" && *status != "done" && *status != "error" {
			return usageError(stderr)
		}
		query := url.Values{"limit": {strconv.Itoa(*limit)}, "offset": {strconv.Itoa(*offset)}, "status": {*status}, "search": {*search}}
		path = "/tasks?" + query.Encode()
	case "add":
		f := flags("add")
		folder, name := f.String("folder", "", "save folder"), f.String("name", "", "output name")
		if f.Parse(rest) != nil || f.NArg() != 1 {
			return usageError(stderr)
		}
		link, err := url.Parse(f.Arg(0))
		if err != nil || (link.Scheme != "http" && link.Scheme != "https") || link.Host == "" || link.User != nil {
			return usageError(stderr)
		}
		method, path = http.MethodPost, "/start-headless-download"
		body = map[string]any{"downloadSource": map[string]any{"link": f.Arg(0)}, "folder": *folder, "name": *name, "useDefaults": true}
	case "pause", "resume", "retry":
		if len(rest) < 1 || len(rest) > 1000 {
			return usageError(stderr)
		}
		ids := make([]int64, 0, len(rest))
		seen := map[int64]bool{}
		for _, value := range rest {
			id, err := strconv.ParseInt(value, 10, 64)
			if err != nil || id <= 0 {
				return usageError(stderr)
			}
			if !seen[id] {
				ids = append(ids, id)
				seen[id] = true
			}
		}
		action := command
		if action == "retry" {
			action = "requeue"
		}
		method, path = http.MethodPost, "/tasks/batch"
		body = map[string]any{"action": action, "ids": ids}
	case "exit":
		if len(rest) != 0 {
			return usageError(stderr)
		}
		method, path = http.MethodPost, "/system/exit"
	default:
		return usageError(stderr)
	}
	token := os.Getenv("TRUEDOWN_API_TOKEN")
	if token == "" {
		origin, _ := url.Parse(endpoint)
		local := origin != nil && (origin.Hostname() == "127.0.0.1" || strings.EqualFold(origin.Hostname(), "localhost") || origin.Hostname() == "::1")
		if dataDir == "" && local {
			executable, err := os.Executable()
			if err != nil {
				fmt.Fprintln(stderr, "cannot resolve launcher directory")
				return 1
			}
			location, err := profile.Resolve("", filepath.Dir(executable))
			if err != nil {
				fmt.Fprintln(stderr, err)
				return 1
			}
			dataDir = location.DataDirectory
		}
	}
	if token == "" && dataDir != "" {
		location, err := profile.Resolve(dataDir, "")
		if err != nil {
			fmt.Fprintln(stderr, "cannot resolve credential profile")
			return 1
		}
		data, err := safefile.ReadFile(location.Paths.File(profile.Token), 1024)
		if err != nil && !os.IsNotExist(err) {
			fmt.Fprintln(stderr, "cannot read local API token")
			return 1
		}
		// Token files may contain one terminal newline; never normalize the token.
		token = string(data)
		if strings.HasSuffix(token, "\r\n") {
			token = strings.TrimSuffix(token, "\r\n")
		} else {
			token = strings.TrimSuffix(token, "\n")
		}
	}
	c, err := client.New(endpoint, token)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	defer c.Close()
	info, err := c.Handshake(ctx)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	data, err := c.Request(ctx, method, path, body)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	result := json.RawMessage(data)
	switch command {
	case "status", "list":
		var tasks page
		if json.Unmarshal(data, &tasks) != nil {
			fmt.Fprintln(stderr, "invalid task response")
			return 1
		}
		if command == "status" {
			result, _ = json.Marshal(map[string]any{"core": info, "summary": tasks.Summary})
			if !jsonOutput {
				fmt.Fprintf(stdout, "TrueDown %s (protocol %d, %s)\n", clean(info.Version), info.ProtocolVersion, clean(info.Mode))
				for _, key := range []string{"total", "queued", "downloading", "paused", "done", "error"} {
					fmt.Fprintf(stdout, "%s: %d\n", key, tasks.Summary[key])
				}
			}
		} else if !jsonOutput {
			w := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tSTATUS\tPROGRESS\tNAME")
			for _, t := range tasks.Tasks {
				fmt.Fprintf(w, "%d\t%s\t%s\t%s\n", t.ID, clean(t.Status), clean(t.Progress), clean(t.Name))
			}
			w.Flush()
			fmt.Fprintf(stdout, "%d shown / %d matching\n", len(tasks.Tasks), tasks.Total)
		}
	case "add":
		result, _ = json.Marshal(map[string]string{"result": strings.TrimSpace(string(data))})
		if !jsonOutput {
			fmt.Fprintln(stdout, clean(strings.TrimSpace(string(data))))
		}
	case "pause", "resume", "retry":
		var op operation
		if json.Unmarshal(data, &op) != nil {
			fmt.Fprintln(stderr, "invalid task-operation response")
			return 1
		}
		if !jsonOutput {
			fmt.Fprintf(stdout, "%d succeeded, %d failed\n", len(op.Succeeded), len(op.Failed))
			for _, failed := range op.Failed {
				fmt.Fprintf(stderr, "%d: %s\n", failed.ID, clean(failed.Error))
			}
		}
		if jsonOutput {
			fmt.Fprintln(stdout, string(result))
		}
		if len(op.Failed) > 0 {
			return 3
		}
		return 0
	case "exit":
		if !json.Valid(result) {
			fmt.Fprintln(stderr, "invalid exit response")
			return 1
		}
		if !jsonOutput {
			fmt.Fprintln(stdout, "Graceful shutdown requested.")
		}
	}
	if jsonOutput {
		fmt.Fprintln(stdout, string(result))
	}
	return 0
}

func usageError(w io.Writer) int {
	fmt.Fprintln(w, "invalid command or arguments; use truedown --help")
	return 2
}
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, s)
}
