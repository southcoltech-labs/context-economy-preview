# Changesets

Every pull request that changes a plugin adds one changeset: `npm run changeset`, pick `patch`, `minor` or `major`, and write the line users will read in the release notes.

The one versioned package is the repository root. `npm run version` applies the pending changesets, then copies the new version into every promoted `plugin.json` and the marketplace's `metadata.version` (see `scripts/sync-plugin-version.mjs`). CI fails a pull request whose manifests disagree with `package.json`.

CI runs `changeset status --since=origin/main` and fails a pull request without a changeset. Exempt, checked by `scripts/changeset-gate.mjs`: a pull request labeled `no-release` whose every changed file is documentation (`docs/`, root-level `*.md`, this README, `LICENSE`, `NOTICE`; never anything under a plugin directory), and the generated version PR (`changeset-release/main` from this repository). `npx changeset --empty` also satisfies the check.
