#!/usr/bin/env bash
set -euo pipefail

target_os=${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}
target_arch=${2:-$(uname -m)}
case "$target_os" in
  linux|darwin) ;;
  *) echo "target OS must be linux or darwin" >&2; exit 2 ;;
esac
case "$target_arch" in
  x86_64) target_arch=amd64 ;;
  aarch64) target_arch=arm64 ;;
esac
case "$target_arch" in
  amd64|arm64) ;;
  *) echo "target architecture must be amd64 or arm64" >&2; exit 2 ;;
esac
if [[ "$target_os" == darwin && "$target_arch" != arm64 ]]; then
  echo "macOS builds require Apple Silicon (arm64)" >&2; exit 2
fi

version=${TRUEDOWN_VERSION:-dev}
build_number=${TRUEDOWN_BUILD_NUMBER:-0}
commit=${TRUEDOWN_COMMIT:-unknown}
[[ "$version" =~ ^(dev|truedown-build-[1-9][0-9]*)$ ]] || { echo "invalid TrueDown version" >&2; exit 2; }
[[ "$build_number" =~ ^(0|[1-9][0-9]{0,12})$ ]] || { echo "invalid TrueDown build number" >&2; exit 2; }
if [[ "$version" != dev && "$version" != "truedown-build-$build_number" ]]; then
  echo "version and build number must identify the same release" >&2; exit 2
fi
if [[ "$build_number" == 0 ]]; then
  [[ "$version" == dev && "$commit" == unknown ]] || { echo "development identity must be dev/0/unknown" >&2; exit 2; }
else
  [[ "$version" == "truedown-build-$build_number" && "$commit" =~ ^[a-f0-9]{40}$ ]] || { echo "release identity requires a full commit" >&2; exit 2; }
fi

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dist_root="$project_root/dist"
output="$dist_root/TrueDown-$target_os-$target_arch"
[[ ! -L "$dist_root" ]] || { echo "refusing to traverse a symbolic-link dist directory" >&2; exit 1; }
mkdir -p "$dist_root"
case "$output" in
  "$dist_root"/TrueDown-linux-amd64|"$dist_root"/TrueDown-linux-arm64|"$dist_root"/TrueDown-darwin-arm64) ;;
  *) echo "unsafe output path: $output" >&2; exit 1 ;;
esac
[[ ! -L "$output" ]] || { echo "refusing to replace a symbolic-link output" >&2; exit 1; }
cmp -s "$project_root/../shared/components.js" "$project_root/web/components.js" || {
  echo "truedown/web/components.js is stale; run npm run ui:sync" >&2
  exit 1
}

staging=$(mktemp -d "$dist_root/.truedown-$target_os-$target_arch-XXXXXX")
cleanup() {
  case "$staging" in
    "$dist_root"/.truedown-*) rm -rf "$staging" ;;
  esac
}
trap cleanup EXIT

case "$target_os-$target_arch" in
  linux-amd64) target=x86_64-unknown-linux-gnu ;;
  linux-arm64) target=aarch64-unknown-linux-gnu ;;
  darwin-arm64) target=aarch64-apple-darwin ;;
esac
host=$(rustc -vV | sed -n 's/^host: //p')
[[ "$host" == "$target" ]] || { echo "native packages must be built on their matching OS and architecture" >&2; exit 2; }
export CARGO_BUILD_TARGET="$target"
export TRUEDOWN_VERSION="$version" TRUEDOWN_BUILD_NUMBER="$build_number" TRUEDOWN_COMMIT="$commit"
if [[ "$target_os" == darwin ]]; then
  # GitHub exposes missing optional secrets as empty variables. Tauri checks
  # presence, so remove wholly empty credential groups before it imports them.
  if [[ -z "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD
  fi
  if [[ -z "${APPLE_ID:-}" && -z "${APPLE_PASSWORD:-}" && -z "${APPLE_TEAM_ID:-}" ]]; then
    unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  fi
  # Developer ID credentials use Tauri's signing environment. Ad-hoc signing
  # is the explicit credential-free default and does not imply notarization.
  export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
  plist_build=$build_number
  [[ "$plist_build" -gt 0 ]] || plist_build=1
  (cd "$project_root/desktop" && npm run build -- --target "$target" --bundles app \
    --config "{\"bundle\":{\"macOS\":{\"bundleVersion\":\"$plist_build\"}}}")
else
  (cd "$project_root/desktop" && npm run build -- --target "$target" --no-bundle)
fi
target_directory=$(cd "$project_root/desktop" && cargo metadata --locked --no-deps --format-version 1 | \
  node -e 'let input="";process.stdin.on("data",part=>input+=part);process.stdin.on("end",()=>process.stdout.write(JSON.parse(input).target_directory))')
native_output="$target_directory/$target/release"
if [[ "$target_os" == darwin ]]; then
  bundle="$staging/TrueDown.app"
  [[ -d "$native_output/bundle/macos/TrueDown.app" && ! -L "$native_output/bundle/macos/TrueDown.app" ]]
  ditto "$native_output/bundle/macos/TrueDown.app" "$bundle"
  plutil -lint "$bundle/Contents/Info.plist"
  codesign --verify --deep --strict "$bundle"
else
  for name in TrueDown truedown-core truedown-cli; do
    [[ -f "$native_output/$name" && ! -L "$native_output/$name" ]] || { echo "missing native component: $name" >&2; exit 1; }
    cp "$native_output/$name" "$staging/$name"
    chmod 755 "$staging/$name"
  done
  cp "$project_root/linux/truedown.desktop" "$staging/truedown.desktop"
  cp "$project_root/web/truedown-logo.svg" "$staging/truedown.svg"
fi
cp "$project_root/unix/README.md" "$staging/README.md"
cp "$project_root/THIRD_PARTY_NOTICES.md" "$staging/THIRD_PARTY_NOTICES.md"
cp "$project_root/dist/NATIVE_LICENSES.txt" "$staging/NATIVE_LICENSES.txt"

if [[ -e "$output" ]]; then
  [[ ! -L "$output" ]] || { echo "refusing to replace a symbolic-link output" >&2; exit 1; }
  rm -rf "$output"
fi
mv "$staging" "$output"
staging=""
printf 'Build OK -> %s\n' "$output"
