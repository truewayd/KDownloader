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

# Exercise the real build entry point up to npm without requiring a foreign
# compiler or a macOS keychain. The sentinel stops before any bundle is written.
mkdir -p "$fixture/native/desktop" "$fixture/native/web" "$fixture/shared" "$fixture/bin"
cp "$project_root/build-unix.sh" "$fixture/native/build-unix.sh"
printf 'shared fixture\n' >"$fixture/shared/components.js"
cp "$fixture/shared/components.js" "$fixture/native/web/components.js"
cat >"$fixture/bin/rustc" <<'MOCK'
#!/usr/bin/env bash
printf 'host: %s\n' "$TRUEDOWN_TEST_RUST_HOST"
MOCK
cat >"$fixture/bin/npm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "run build -- --target $CARGO_BUILD_TARGET "* ]]
case "$TRUEDOWN_TEST_SIGNING_CASE" in
  linux) [[ "$*" == *'--no-bundle' ]] ;;
  empty)
    [[ "$*" == *'--bundles app'* && "$APPLE_SIGNING_IDENTITY" == '-' ]]
    [[ -z "${APPLE_CERTIFICATE+x}" && -z "${APPLE_CERTIFICATE_PASSWORD+x}" ]]
    [[ -z "${APPLE_ID+x}" && -z "${APPLE_PASSWORD+x}" && -z "${APPLE_TEAM_ID+x}" ]]
    ;;
  configured)
    [[ "$APPLE_SIGNING_IDENTITY" == 'Developer ID fixture' ]]
    [[ "$APPLE_CERTIFICATE" == 'fixture certificate' && "$APPLE_CERTIFICATE_PASSWORD" == 'fixture password' ]]
    [[ "$APPLE_ID" == 'fixture@example.test' && "$APPLE_PASSWORD" == 'fixture app password' && "$APPLE_TEAM_ID" == 'fixture team' ]]
    ;;
  unprotected)
    [[ "$APPLE_CERTIFICATE" == 'fixture certificate' ]]
    [[ "${APPLE_CERTIFICATE_PASSWORD+x}" == x && -z "$APPLE_CERTIFICATE_PASSWORD" ]]
    ;;
esac
touch "$TRUEDOWN_TEST_NPM_REACHED"
exit 73
MOCK
chmod +x "$fixture/bin/rustc" "$fixture/bin/npm"
export TRUEDOWN_TEST_NPM_REACHED="$fixture/npm-reached"

assert_build_reaches_npm() {
  local status=0
  rm -f "$TRUEDOWN_TEST_NPM_REACHED"
  PATH="$fixture/bin:$PATH" bash "$fixture/native/build-unix.sh" "$1" "$2" >"$fixture/result" 2>&1 || status=$?
  if [[ "$status" != 73 || ! -f "$TRUEDOWN_TEST_NPM_REACHED" ]]; then
    cat "$fixture/result" >&2
    echo "Native build did not reach npm with the expected target and signing environment ($1/$2)" >&2
    exit 1
  fi
}

export APPLE_SIGNING_IDENTITY='' APPLE_CERTIFICATE='' APPLE_CERTIFICATE_PASSWORD=''
export APPLE_ID='' APPLE_PASSWORD='' APPLE_TEAM_ID=''
for spec in 'linux amd64 x86_64-unknown-linux-gnu' 'linux arm64 aarch64-unknown-linux-gnu' \
  'darwin arm64 aarch64-apple-darwin'; do
  read -r os arch host <<<"$spec"
  export TRUEDOWN_TEST_RUST_HOST="$host"
  export TRUEDOWN_TEST_SIGNING_CASE=empty
  [[ "$os" != linux ]] || export TRUEDOWN_TEST_SIGNING_CASE=linux
  assert_build_reaches_npm "$os" "$arch"
done
export TRUEDOWN_TEST_SIGNING_CASE=configured
export APPLE_SIGNING_IDENTITY='Developer ID fixture'
export APPLE_CERTIFICATE='fixture certificate' APPLE_CERTIFICATE_PASSWORD='fixture password'
export APPLE_ID='fixture@example.test' APPLE_PASSWORD='fixture app password' APPLE_TEAM_ID='fixture team'
assert_build_reaches_npm darwin arm64
export TRUEDOWN_TEST_SIGNING_CASE=unprotected APPLE_CERTIFICATE_PASSWORD=''
assert_build_reaches_npm darwin arm64

rm -f "$TRUEDOWN_TEST_NPM_REACHED"
for arch in amd64 x86_64; do
  if PATH="$fixture/bin:$PATH" bash "$fixture/native/build-unix.sh" darwin "$arch" >"$fixture/result" 2>&1; then
    echo 'Native build unexpectedly accepted macOS Intel' >&2
    exit 1
  fi
  grep -q 'macOS builds require Apple Silicon' "$fixture/result"
  [[ ! -e "$TRUEDOWN_TEST_NPM_REACHED" ]]
done
if PATH="$fixture/bin:$PATH" bash "$fixture/native/build-unix.sh" linux amd64 >"$fixture/result" 2>&1; then
  echo 'Native build unexpectedly accepted a mismatched Rust host' >&2
  exit 1
fi
grep -q 'matching OS and architecture' "$fixture/result"
[[ ! -e "$TRUEDOWN_TEST_NPM_REACHED" ]]
printf 'Unix native target and optional macOS signing environments: PASS\n'
