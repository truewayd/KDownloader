#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
binary_root=$(readlink -f "${1:-$repo_root/dist/linux-tests}")
if [[ ! -d "$binary_root" ]]; then
  echo "Linux test binary directory is missing: $binary_root" >&2
  exit 2
fi

run_root=$(mktemp -d /tmp/truedown-linux-tests-XXXXXX)
case "$run_root" in
  /tmp/truedown-linux-tests-*) ;;
  *) echo "unsafe temporary directory: $run_root" >&2; exit 1 ;;
esac
cleanup() {
  case "$run_root" in
    /tmp/truedown-linux-tests-*) rm -rf "$run_root" ;;
  esac
}
trap cleanup EXIT

run_package() {
  name=$1
  working_directory=$2
  integration=${3:-0}
  source_binary="$binary_root/$name.test"
  target_binary="$run_root/$name.test"
  if [[ ! -f "$source_binary" ]]; then
    echo "Linux test binary is missing: $source_binary" >&2
    exit 2
  fi
  cp "$source_binary" "$target_binary"
  chmod 700 "$target_binary"
  echo "linux-test: $name"
  if [[ "$integration" == 1 ]]; then
    (cd "$working_directory" && TRUEDOWN_INTEGRATION=1 "$target_binary")
  else
    (cd "$working_directory" && "$target_binary")
  fi
}

run_package truedown "$repo_root" 1
run_package api "$repo_root/internal/api"
run_package applog "$repo_root/internal/applog"
run_package downloader "$repo_root/internal/downloader" 1
run_package safefile "$repo_root/internal/safefile"
run_package systemupdate "$repo_root/internal/systemupdate"
