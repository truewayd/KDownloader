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

version=${TRUEDOWN_VERSION:-dev}
build_number=${TRUEDOWN_BUILD_NUMBER:-0}
commit=${TRUEDOWN_COMMIT:-unknown}
[[ "$version" =~ ^(dev|truedown-build-[1-9][0-9]*)$ ]] || { echo "invalid TrueDown version" >&2; exit 2; }
[[ "$build_number" =~ ^[0-9]+$ ]] || { echo "invalid TrueDown build number" >&2; exit 2; }
[[ "$commit" =~ ^(unknown|[0-9a-fA-F]{7,40})$ ]] || { echo "invalid TrueDown commit" >&2; exit 2; }

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
dist_root="$project_root/dist"
output="$dist_root/TrueDown-$target_os-$target_arch"
mkdir -p "$dist_root"
case "$output" in
  "$dist_root"/TrueDown-linux-amd64|"$dist_root"/TrueDown-linux-arm64|"$dist_root"/TrueDown-darwin-amd64|"$dist_root"/TrueDown-darwin-arm64) ;;
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

ldflags="-s -w -X main.version=$version -X main.buildNumber=$build_number -X main.commit=$commit"
if [[ "$target_os" == darwin ]]; then
  bundle="$staging/TrueDown.app"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  (cd "$project_root" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
    go build -trimpath -ldflags "$ldflags" -o "$bundle/Contents/MacOS/TrueDown" .)
  cp "$project_root/macos/truedown.icns" "$bundle/Contents/Resources/truedown.icns"
  plist_build=$build_number
  [[ "$plist_build" -gt 0 ]] || plist_build=1
  sed "s/@BUILD_NUMBER@/$plist_build/g" "$project_root/macos/Info.plist.in" >"$bundle/Contents/Info.plist"
  cp "$project_root/unix/README.md" "$staging/README.md"
  cp "$project_root/THIRD_PARTY_NOTICES.md" "$staging/THIRD_PARTY_NOTICES.md"
else
  (cd "$project_root" && CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" \
    go build -trimpath -ldflags "$ldflags" -o "$staging/TrueDown" .)
  chmod 755 "$staging/TrueDown"
  cp "$project_root/linux/truedown.desktop" "$staging/truedown.desktop"
  cp "$project_root/web/truedown-logo.svg" "$staging/truedown.svg"
  cp "$project_root/unix/README.md" "$staging/README.md"
  cp "$project_root/THIRD_PARTY_NOTICES.md" "$staging/THIRD_PARTY_NOTICES.md"
fi

if [[ -e "$output" ]]; then
  rm -rf "$output"
fi
mv "$staging" "$output"
staging=""
printf 'Build OK -> %s\n' "$output"
