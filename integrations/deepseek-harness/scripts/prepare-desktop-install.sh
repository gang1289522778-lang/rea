#!/usr/bin/env bash
# Prepare a checksum-verified release tarball instead of the Git-root REA CLI.
set -euo pipefail

VERSION=0.2.1
NAME="dsh-rea-bundle-$VERSION.tgz"
URL="https://github.com/morluto/rea/releases/download/dsh-v$VERSION/$NAME"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
BUNDLE_DIR="$HOME_DIR/plugin-packages"
TARGET="$BUNDLE_DIR/$NAME"
INSTALL=0

usage() {
  cat <<'HELP'
Usage: bash prepare-desktop-install.sh [--install | --help]
Default: download and verify the official REA release tarball, then show the
absolute path to paste into DeepSeek Harness Desktop > Plugins > Add plugin.
--install: run the installed Desktop-owned dsh command after fully quitting
           Desktop. The normal npm dsh cannot manage the reserved desktop profile.

Do NOT add https://github.com/morluto/rea as a plugin! The Git repository
root is the build-required rea-agents CLI; pnpm correctly blocks its prepare
script unless allowBuilds is weakened. Use the verified plugin .tgz instead.
HELP
}

case "$#" in
  0) ;;
  1)
    case "$1" in
      --install) INSTALL=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; exit 2 ;;
    esac ;;
  *) usage >&2; exit 2 ;;
esac

command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }
if command -v shasum >/dev/null; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
else
  echo 'SHA-256 verifier not found' >&2
  exit 1
fi

command -v node >/dev/null || { echo 'Node.js is required' >&2; exit 1; }
umask 077
mkdir -p "$BUNDLE_DIR"
checksums="$(mktemp "$BUNDLE_DIR/.rea-checksums.XXXXXXXX")"
trap 'rm -f "$checksums"' EXIT
curl --fail --location --retry 3 --silent --show-error --output "$checksums" "${URL%/*}/SHA256SUMS"
DIGEST="$(awk -v name="$NAME" '$2 == name { print $1 }' "$checksums")"
[[ "$DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo 'REA plugin SHA-256 mismatch or missing release checksum' >&2; exit 1; }
rm -f "$checksums"
trap - EXIT
if [[ ! -f "$TARGET" ]] || [[ "$(checksum "$TARGET")" != "$DIGEST" ]]; then
  temp="$(mktemp "$BUNDLE_DIR/.rea-download.XXXXXXXX")"
  trap 'rm -f "$temp"' EXIT
  curl --fail --location --retry 3 --silent --show-error --output "$temp" "$URL"
  if [[ "$(checksum "$temp")" != "$DIGEST" ]]; then
    echo 'REA plugin SHA-256 mismatch; refusing installation' >&2
    exit 1
  fi
  mv -f "$temp" "$TARGET"
  trap - EXIT
fi
[[ "$(checksum "$TARGET")" == "$DIGEST" ]] || {
  echo 'REA plugin SHA-256 mismatch; refusing installation' >&2
  exit 1
}
printf 'Verified REA plugin: %s\n' "$TARGET"

MANIFEST="$HOME_DIR/profiles/desktop/package.json"
if [[ -f "$MANIFEST" ]] && node --input-type=module - "$MANIFEST" <<'NODE'
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const spec = config.dependencies?.["rea-agents"];
if (typeof spec !== "string") process.exit(1);
const normalized = decodeURIComponent(spec).replace(/^git\+/, "").replace(/\.git(?=#|$)/, "").replace(/\/$/, "");
const untaggedRoot = /^(?:https?:\/\/github\.com\/|github:|git@github\.com:)(?:xxxxxwater|morluto)\/rea$/.test(normalized);
process.exit(untaggedRoot ? 0 : 1);
NODE
then
  echo 'WARNING: Desktop profile still references the wrong untagged rea-agents Git checkout.' >&2
  echo 'Back up the profile; remove ONLY that dependency via the Desktop plugin manager.' >&2
fi

if [[ "$INSTALL" == 1 ]]; then
  command -v dsh >/dev/null || {
    echo 'Desktop dsh command not found. Use Desktop > Plugins > Add plugin.' >&2
    exit 2
  }
  if ! dsh plugin --profile desktop add "$TARGET"; then
    echo 'Use Desktop > Plugins > Add plugin with the verified local .tgz path above.' >&2
    echo 'Alternatively install the Desktop-owned dsh command via its app menu,' >&2
    echo 'quit Desktop completely, and rerun --install.' >&2
    exit 3
  fi
  echo 'Installed: restart DeepSeek Harness Desktop.'
else
  printf '\nDesktop > Plugins > Add plugin: paste this local path:\n%s\n' "$TARGET"
  echo 'Enable dsh-rea-bundle and restart Desktop. Do not paste the GitHub repo URL.'
fi
