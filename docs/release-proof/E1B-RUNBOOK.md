# E1b release drill: runbook

E1b proves the release policy (install and update from `release`, roll back only to `promoted-v<version>`) for tool-gateway. It proves the update and rollback loop on both hosts, in the **staging** repository `southcoltech-labs/context-economy-preview`. It runs once before the public preview, and again whenever the release workflow, the promotion mechanism or a tested host version changes, and before 1.0.

The record is `docs/release-proof/e1b-<date>.md`: host versions, platform, each command with its output, the installed commits, every override check's output, and the data checks.

## Before you start

- The staging repository is public, with the release App, the `release` environment and the rulesets (`docs/MAINTAINER-SETUP.md`). All of these need the owner.
- Release **A** is promoted: `release` and `promoted-v<A>` point at A's commit. A and B share the ledger row formats `ce.claude-gateway.v1` and `ce.pi-gateway.v1`.
- One clean machine or user account for the drill (the **E1b account**), with RTK configured from the README (§1) through `config.json` only, never `CE_RTK_BIN` (below). No earlier install is present under `~/.claude/` or `~/.pi/`. Its data stays in place from step 1 to step 6.
- B's E1a (step 3) runs on **separate** clean accounts, never the E1b account: E1a installs and uninstalls the candidate, which would disturb the drill's baseline.

```bash
STAGING=southcoltech-labs/context-economy-preview
A=<version A>    SHA_A=<git rev-parse "promoted-v$A^{commit}">
```

Read the installed commits with these two commands. The Claude line and the Pi line must show the same commit:

```bash
node -e 'const p=require(process.env.HOME+"/.claude/plugins/installed_plugins.json").plugins;console.log("tool-gateway",p["tool-gateway@context-economy"]?.[0]?.gitCommitSha??"not installed")'
git -C ~/.pi/agent/git/github.com/$STAGING rev-parse HEAD
```

Check the data with `scripts/e1b-data.mjs`, run from a staging checkout. It only reads. It writes nothing under `~/.claude/`.

**RTK from `config.json` alone.** The drill proves the gateway still reads `config.json` after each move. `CE_RTK_BIN` takes precedence over the file, and with it set a rewrite succeeds without reading the file at all. So on the E1b account:
- RTK is configured only by `rtk.path` in `~/.claude/context-economy/config.json`: the absolute path the README's RTK block printed.
- `CE_RTK_BIN` is set nowhere: not in the shell that starts either host, not under `env` in any Claude Code settings file.
- Both hosts are started from one shell, in one drill folder, where the override check below passed, and restarted after any change to this set-up. This holds from step 1 to step 6.

**Override check.** Run it from the drill folder, in the shell that starts both hosts, before the baseline and at every still-rewriting check. Record its output each time. It must print `CE_RTK_BIN absent` for the shell and for every settings file, and the `rtk.path` line:

```bash
unset CE_RTK_BIN
[ -z "${CE_RTK_BIN+x}" ] && echo "shell: CE_RTK_BIN absent"
for f in ~/.claude/settings.json .claude/settings.json .claude/settings.local.json \
         "/Library/Application Support/ClaudeCode/managed-settings.json" /etc/claude-code/managed-settings.json; do
  [ -f "$f" ] && node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[1]+": CE_RTK_BIN "+(s.env&&"CE_RTK_BIN" in s.env?"PRESENT":"absent"))' "$f"
done
node -e 'console.log("rtk.path:",require(process.env.HOME+"/.claude/context-economy/config.json").rtk.path)'
```

A `PRESENT` line, or a missing `shell:` line, stops the drill until the override is removed and both hosts are restarted. A route that configures RTK by `CE_RTK_BIN` is not evidence that the file is read; if it is tested, it is recorded separately, under its own heading.

**Still rewriting.** Wherever a step below says so, run the override check, then make one `git status` call on each host (Claude Code `Bash`, Pi `bash`). Each must run as `'<rtk path>' git status`, where `<rtk path>` is the `rtk.path` the check printed, with a new ledger row `"rewrite":"applied"` in `gateway-ledger/` and `gateway-ledger-pi/`. With the override absent, that shows `config.json` is still read.

## 1. Install A and record the baseline

```bash
claude plugin marketplace add "$STAGING#release"
claude plugin install tool-gateway@context-economy
pi install "git:github.com/$STAGING@release"
```

1. Both installed commits are `$SHA_A`.
2. Start both hosts from the drill shell after the override check passes. Make a few shell calls on each host, so both ledgers have rows. Check that they are still rewriting.
3. Take the snapshot:

   ```bash
   node scripts/e1b-data.mjs snapshot ~/e1b-snapshot.json
   ```

   `snapshot` refuses, and writes nothing, until there is a row in each of `gateway-ledger/` and `gateway-ledger-pi/`, and `config.json` names `rtk.path`. It stores a hash of every ledger row and `config.json`'s exact bytes.

## 2. An unreleased version is not delivered

Merge B's version PR on staging `main`. This is the changesets PR that sets every manifest to version B. It creates the candidate tag `v<B>`, a prerelease, but does **not** promote it: `release` stays at A. Main now carries a newer version than the installed one, so a host that followed `main` would offer an update.

```bash
B=<version B>    SHA_B=<git rev-parse "v$B^{commit}">    # = staging main's HEAD
```

Record `main`'s version (B) and SHA (`$SHA_B`), and `release`'s version (A) and SHA (`$SHA_A`). Then update as the README §3 says:

```bash
claude plugin marketplace update context-economy
claude plugin update tool-gateway@context-economy
pi update --extensions
```

Both installed commits are still `$SHA_A`. No update to B is offered or applied.

## 3. Prove and promote B

1. Run E1a for `v<B>` on the separate clean accounts, following `E1A-RUNBOOK.md`, and merge its proof to `main` as a docs-only `no-release` PR.
2. Promote B: approve the `release` environment. `promoted-v<B>` is created and `release` moves to `$SHA_B`.
3. Record `release`'s SHA: `git rev-parse "promoted-v$B^{commit}"` must equal `$SHA_B`.

## 4. Update to B

Run the step 2 update commands again, then restart both hosts from the drill shell.

1. Both installed commits are `$SHA_B`.
2. B's behaviour works: run the E1a behaviour table once on each host, and the still-rewriting check, override check included.
3. Run `node scripts/e1b-data.mjs check ~/e1b-snapshot.json`. It must print "survive".

## 5. Roll back to A, then return

Follow the README §4 exactly:

```bash
claude plugin marketplace remove context-economy
claude plugin marketplace add "$STAGING#promoted-v$A"
claude plugin install tool-gateway@context-economy
pi install "git:github.com/$STAGING@promoted-v$A"
```

1. Both installed commits are `$SHA_A`, and both hosts are still rewriting.
2. `e1b-data.mjs check` passes: every baseline ledger row is present and unchanged, and `config.json` is byte-identical.
3. Run the update commands. Both hosts stay at `$SHA_A`, because the tag is pinned.

Return to updates with the README's install commands at `#release` and `@release`. Both installed commits are `$SHA_B`, both hosts are still rewriting, and `check` passes again.

## 6. Uninstall

```bash
claude plugin uninstall tool-gateway@context-economy
pi remove "git:github.com/$STAGING"
```

1. After a restart, no hook or extension runs: a shell call is not rewritten, and no ledger row is added.
2. `check` still passes: uninstall keeps the data.
3. The data left is exactly what the README lists: `gateway-ledger/`, `gateway-ledger-pi/` and `config.json`.

## Not covered

A drill across a schema floor. A and B share the ledger row formats, so no floor is crossed. The first release that changes one reruns E1b across that floor and checks the README's floor statement.
