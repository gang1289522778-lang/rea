# REA DeepSeek Harness plugin v0.2.1 — Desktop Git install fix

The previous REA repository URL downloaded the main `rea-agents` package,
whose Git `prepare` script was blocked by pnpm and which was not a Harness
bundle. This release provides a dedicated **build-free Git distribution tag**
containing the actual `dsh-rea-bundle` package at the Git checkout root.

## Desktop — paste into “Add plugin”

```text
https://github.com/morluto/rea#dsh-plugin-v0.2.1
```

Or use the GitHub shorthand:

```text
github:morluto/rea#dsh-plugin-v0.2.1
```

The `dsh-plugin-v0.2.1` tag points to a separate orphan Git commit containing
only `package.json`, `cordis.patch.yml`, `launcher.mjs`, both guides and
`LICENSE`. It is not the REA `main` checkout and has **no prepare/install
scripts**. Desktop's plugin manager accepts versioned Git URLs and should
install the profile bundle without changing `allowBuilds`.

Alternate direct Release asset, also accepted by the current plugin manager:

```text
https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
```

Install either one, not both. If your Desktop profile already contains the
_wrong_ `rea-agents` Git dependency from the former attempt, remove only that
dependency first through Desktop's plugin manager. Existing users of
`rea setup --client dsh` should also remove the obsolete home-level
`rea-mcp` patch **after a backup**, otherwise it shadows the new bundle.

## Changes

- Git tag packaging that can be pasted directly into Desktop “Add plugin”
- Versioned `dsh-v0.2.1` GitHub Release archive
- No install-time build hooks; pinned npm `rea-agents@6.4.0` runtime
- Separate checks for the minimal Git tag and tarball, plus real Harness MCP
  initialization and tool composition
- Desktop recovery instructions and reproducible distribution tests

The REA core in `main` and its npm/registry release process remain unchanged.
Native Desktop GUI and live model API acceptance require validation on a
real installed Desktop application.

Publication is opt-in through the repository variable `REA_DSH_PUBLISH=true`.
The candidate has not been qualified in native Desktop or through a fully booted
Harness profile. Keep publication disabled until those required lanes are reviewed.
