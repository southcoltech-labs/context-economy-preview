# E1a candidate check: runbook

E1a gates every promotion: a candidate tag `v<version>` is installed on each supported platform, from the README alone, against the **staging** repository `southcoltech-labs/context-economy-preview`, on both hosts. It proves what ships: tool-gateway, one Claude Code plugin and one Pi extension. The result is `docs/release-proof/<version>.json` on `main`, which `promote.mjs` validates. A transcript goes in `docs/release-proof/<version>.md` as supporting evidence.

Run once on **macOS arm64** and once on **Linux x86_64**, each on a clean machine or a clean user account, with nothing from earlier installs under `~/.claude/` or `~/.pi/`.

## Inputs

```bash
STAGING=southcoltech-labs/context-economy-preview   # the staging repository
V=<version>                      # the candidate, e.g. 0.1.0
SHA=<40-hex commit of v$V>       # git rev-parse "v$V^{commit}" in a staging clone
```

## 1. Configure (README §1 only)

Follow the README's "Configure RTK" exactly: the RTK block (it must end with `rtk 0.47.0` and the `rtk.path` line), and `~/.claude/context-economy/config.json`. Note anything the README did not tell you; a gap fails the run.

## 2. Install the candidate

E1a installs the candidate tag, not `release`:

```bash
claude plugin marketplace add "$STAGING#v$V"
claude plugin install tool-gateway@context-economy
pi install "git:github.com/$STAGING@v$V"
```

Restart both hosts.

## 3. Use each behaviour

Record each command and its output in the transcript. Do not uninstall yet: step 4 reads the installed state.

| Host | Behaviour | Pass when |
| --- | --- | --- |
| Claude Code | A Bash call such as `git status` | It runs as `'<rtk path>' git status`; a ledger row in `~/.claude/context-economy/gateway-ledger/` has `"rewrite":"applied"`. A permission prompt after the rewrite is recorded, not failed |
| Pi | A `bash` tool call | Rewritten to the quoted RTK path; a row in `gateway-ledger-pi/` with `"rewrite":"applied"` |

## 4. Capture (before uninstall)

Run from a checkout of the candidate's `main`, with both hosts still installed, giving the install and behaviour results from steps 2–3:

```bash
node scripts/e1a-record.mjs capture --version "$V" --sha "$SHA" --platform macos-arm64 --pi-repo "$STAGING" \
  --claude install=<pass|fail>,behavior=<pass|fail> --pi install=<pass|fail>,behavior=<pass|fail>
```

- `installed_commit` is not attested by you. The recorder reads it from `~/.claude/plugins/installed_plugins.json` (`gitCommitSha` of each plugin the marketplace lists) and from the Pi package clone's HEAD, and passes it only when every one equals `$SHA`.
- It writes `docs/release-proof/$V-<platform>.capture.json`, bound to `$V`, `$SHA`, the platform, `$STAGING` and the Claude and Pi host folders it read.
- Before reading the hosts it removes any earlier run for this platform and any pending capture, so a capture that then fails leaves nothing to finalize or promote. A failed capture is kept as failed; to try again, start over from step 2 and capture again.

## 5. Uninstall

```bash
claude plugin uninstall tool-gateway@context-economy
pi remove "git:github.com/$STAGING"
```

Start each host again. No rewrite happens, and no new ledger rows appear. The data folders left are exactly the ones the README lists.

## 6. Finalize (after uninstall)

```bash
node scripts/e1a-record.mjs finalize --version "$V" --sha "$SHA" --platform macos-arm64 --pi-repo "$STAGING" \
  --claude uninstall=<pass|fail> --pi uninstall=<pass|fail>
```

- Finalize uses the capture's commits and results as they are; it does not read the installed commits again.
- It refuses a missing capture, one for another version, SHA or platform, and a different `--pi-repo`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` or `HOME` than at capture. Run it in the same shell set-up as step 4.
- It checks that the installs are gone: a remaining Claude entry or Pi clone records uninstall as failed.
- It writes this platform's run into `docs/release-proof/$V.json` and deletes the capture, so a capture is used once.

After both platforms: `node scripts/check-release-proof.mjs "$V" "$SHA" tool-gateway --pi tool-gateway` must print "complete pass".

Commit `docs/release-proof/$V.json` and `$V.md` to `main` in a pull request (docs-only, labeled `no-release`). The promotion workflow reads them from there.

## E1b (release drill)

See `E1B-RUNBOOK.md`: it uses the same machine set-up and the README's update and rollback commands, with `scripts/e1b-data.mjs` checking that the ledger rows and `config.json` survive.
