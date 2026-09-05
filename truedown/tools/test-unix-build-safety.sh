#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture=$(mktemp -d /tmp/truedown-build-safety-XXXXXX)
cleanup() {
  case "$fixture" in
    /tmp/truedown-build-safety-*) rm -rf "$fixture" ;;
  esac
}
trap cleanup EXIT

mkdir "$fixture/project" "$fixture/outside"
cp "$project_root/build-unix.sh" "$fixture/project/build-unix.sh"
printf 'keep\n' >"$fixture/outside/sentinel"

assert_metadata_rejected() {
  if TRUEDOWN_VERSION="$1" TRUEDOWN_BUILD_NUMBER="$2" \
    bash "$fixture/project/build-unix.sh" linux amd64 >"$fixture/result" 2>&1; then
    echo "Unix build unexpectedly accepted invalid release metadata" >&2
    exit 1
  fi
  grep -q "$3" "$fixture/result"
  [[ ! -e "$fixture/project/dist" ]]
}

assert_metadata_rejected truedown-build-42 0 'same release'
assert_metadata_rejected truedown-build-42 43 'same release'
assert_metadata_rejected dev 01 'invalid TrueDown build number'
assert_metadata_rejected dev 9223372036854775808 'invalid TrueDown build number'
assert_metadata_rejected dev 100000000000000000000 'invalid TrueDown build number'

assert_rejected() {
  if bash "$fixture/project/build-unix.sh" linux amd64 >"$fixture/result" 2>&1; then
    echo "Unix build unexpectedly accepted a symbolic-link output" >&2
    exit 1
  fi
  grep -q 'symbolic-link' "$fixture/result"
  [[ $(cat "$fixture/outside/sentinel") == keep ]]
  [[ $(find "$fixture/outside" -mindepth 1 -maxdepth 1 | wc -l) -eq 1 ]]
}

ln -s "$fixture/outside" "$fixture/project/dist"
assert_rejected
rm "$fixture/project/dist"
mkdir "$fixture/project/dist"
ln -s "$fixture/outside" "$fixture/project/dist/TrueDown-linux-amd64"
assert_rejected
printf 'Unix build symbolic-link guards: PASS\n'
printf 'Unix build release metadata guards: PASS\n'
