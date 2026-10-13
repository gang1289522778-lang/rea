#!/usr/bin/env bash
# Produce an immutable, build-free Git package from the plugin subdirectory.
# The REA main branch is untouched. The distribution tag points at a standalone
# ROOT package.json (dsh-rea-bundle), not the root rea-agents CLI.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in
  --check|--publish) ;;
  *) echo 'Usage: stage-git-plugin.sh [--check|--publish]' >&2; exit 2 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
PLUGIN='integrations/deepseek-harness'
VERSION="$(node -p 'require("./integrations/deepseek-harness/package.json").version')"
TAG="dsh-plugin-v${VERSION}"
INDEX="$(mktemp)"
rm -f "$INDEX"
trap 'rm -f "$INDEX"' EXIT

node - <<'NODE'
const assert = require("node:assert/strict");
const pkg = require("./integrations/deepseek-harness/package.json");
assert.equal(pkg.name, "dsh-rea-bundle");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
for (const key of ["prepare", "prepack", "postinstall", "install", "preinstall"]) {
  assert.equal(pkg.scripts?.[key], undefined, "git source must not run " + key);
}
assert.equal(pkg.dependencies?.["rea-agents"], "6.4.0");
NODE

# GIT_INDEX_FILE gives a completely isolated index. Stage only the eight files
# that define the installable plugin, at the ROOT of a new orphan tree.
GIT_INDEX_FILE="$INDEX" git read-tree --empty
for NAME in package.json launcher.mjs cordis.patch.yml README.md README.zh-CN.md LICENSE scripts/activate-installed.mjs scripts/cordis-contract.mjs; do
  SOURCE="$PLUGIN/$NAME"
  [[ -f "$SOURCE" ]] || { echo "Missing plugin file: $SOURCE" >&2; exit 1; }
  BLOB="$(git hash-object -w "$SOURCE")"
  GIT_INDEX_FILE="$INDEX" git update-index --add --cacheinfo "100644,$BLOB,$NAME"
done
TREE="$(GIT_INDEX_FILE="$INDEX" git write-tree)"
[[ "$(git ls-tree -r --name-only "$TREE" | wc -l | tr -d ' ')" == '8' ]] || {
  echo 'Invalid standalone plugin distribution tree' >&2; exit 1;
}
git ls-tree --name-only "$TREE"
printf 'Standalone DSH tree: %s\nDistribution tag: %s\n' "$TREE" "$TAG"

if [[ "$MODE" == '--check' ]]; then
  exit 0
fi

# Check remote tags before creating anything; checkout is intentionally shallow
# in Actions and does not fetch existing tags. Published tags are immutable.
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  git fetch --no-tags origin "refs/tags/$TAG:refs/tags/$TAG"
fi

# Never move an existing published tag. A version change is required for any
# changed distribution bytes.
if git rev-parse --verify -q "refs/tags/$TAG" >/dev/null; then
  OLD_TREE="$(git rev-parse "refs/tags/$TAG^{tree}")"
  [[ "$OLD_TREE" == "$TREE" ]] || {
    echo "Refusing to rewrite immutable $TAG; bump the plugin version" >&2; exit 1;
  }
  echo "Existing tag $TAG already points at matching plugin distribution"
  exit 0
fi

COMMIT="$(printf 'build(dsh): standalone plugin %s\n' "$VERSION" |
  git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit-tree "$TREE")"
git tag "$TAG" "$COMMIT"
git push origin "refs/tags/$TAG"
printf 'Published %s -> %s (tree %s)\n' "$TAG" "$COMMIT" "$TREE"
