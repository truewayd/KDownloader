#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: smoke-linux.sh /path/to/TrueDown [port]" >&2
  exit 2
fi

source_bin=$(readlink -f "$1")
port=${2:-15265}
if [[ ! -f "$source_bin" ]]; then
  echo "TrueDown Linux binary is missing: $source_bin" >&2
  exit 2
fi
if ! command -v aria2c >/dev/null || ! command -v curl >/dev/null; then
  echo "aria2c and curl are required for the Linux smoke test" >&2
  exit 2
fi

probe_bin=/tmp/truedown-wsl2-smoke
probe_root=$(mktemp -d /tmp/truedown-wsl2-XXXXXX)
case "$probe_root" in
  /tmp/truedown-wsl2-*) ;;
  *) echo "unsafe temporary directory: $probe_root" >&2; exit 1 ;;
esac

server_pid=""
cleanup() {
	status=$?
	if [[ "$status" -ne 0 ]]; then
		echo "Linux smoke test diagnostics ($probe_root):" >&2
		[[ ! -f "$probe_root/console.log" ]] || cat "$probe_root/console.log" >&2
		[[ ! -f "$probe_root/second.log" ]] || cat "$probe_root/second.log" >&2
		[[ ! -f "$probe_root/truedown.log" ]] || cat "$probe_root/truedown.log" >&2
		[[ ! -f "$probe_root/aria2-console.log" ]] || cat "$probe_root/aria2-console.log" >&2
	fi
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" || true
    wait "$server_pid" || true
  fi
  rm -f "$probe_bin"
  case "$probe_root" in
    /tmp/truedown-wsl2-*) rm -rf "$probe_root" ;;
  esac
}
trap cleanup EXIT

cp "$source_bin" "$probe_bin"
chmod 700 "$probe_bin"
TRUEDOWN_DATA_DIR="$probe_root" \
TRUEDOWN_ADDR="127.0.0.1:$port" \
TRUEDOWN_NO_BROWSER=1 \
  "$probe_bin" >"$probe_root/console.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 100); do
  if curl -fsS -X POST "http://127.0.0.1:$port/ping" >"$probe_root/ping.txt" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  cat "$probe_root/console.log"
  exit 1
fi
[[ $(cat "$probe_root/ping.txt") == pong ]]
curl -fsS "http://127.0.0.1:$port/tasks?limit=1" >"$probe_root/tasks.json"
for _ in $(seq 1 50); do
	grep -q "foreground service ready" "$probe_root/truedown.log" && break
	sleep 0.1
done
grep -q "foreground service ready" "$probe_root/truedown.log"

started=$(date +%s%N)
TRUEDOWN_DATA_DIR="$probe_root" \
TRUEDOWN_ADDR="127.0.0.1:$port" \
TRUEDOWN_NO_BROWSER=1 \
  "$probe_bin" >"$probe_root/second.log" 2>&1
elapsed_ms=$(( ($(date +%s%N) - started) / 1000000 ))
[[ "$elapsed_ms" -lt 3000 ]]
[[ -s "$probe_root/truedown.db" ]]
grep -q "another TrueDown instance owns" "$probe_root/truedown.log"

aria_pid=$(pgrep -P "$server_pid" aria2c || true)
if [[ -z "$aria_pid" ]]; then
	ps -eo pid,ppid,comm,args >&2
	echo "TrueDown has no managed aria2 child" >&2
	exit 1
fi
curl -fsS -X POST "http://127.0.0.1:$port/system/exit" >"$probe_root/exit.json"
grep -q '"accepted":true' "$probe_root/exit.json"
wait "$server_pid"
server_pid=""
sleep 0.2
if kill -0 "$aria_pid" 2>/dev/null; then
  echo "aria2 child remained alive after TrueDown shutdown" >&2
  exit 1
fi
grep -q "dashboard: exit requested" "$probe_root/truedown.log"
grep -q "TrueDown stopped cleanly" "$probe_root/truedown.log"

printf 'ping=pong sqlite=ok tasks=ok single_instance_ms=%s aria2_reaped=ok dashboard_exit=clean\n' "$elapsed_ms"
