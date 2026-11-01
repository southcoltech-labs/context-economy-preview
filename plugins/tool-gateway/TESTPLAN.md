# tool-gateway test plan

The behaviour is specified in [SPEC.md](SPEC.md).

## Automated tests

From the repository root:

```bash
claude plugin validate . --strict
claude plugin test plugins/tool-gateway    # Claude Code plugin and the shared core
bun test extensions                        # Pi extension and its process runner
```

`hooks/gateway.test.ts` runs the Claude Code hook in the host's test harness:
- rewrite applied, none, failed, truncated and outside the grammar;
- the trust check: owner, mode, type, version, identity changes, revalidation timeouts;
- the shared budget, including a `config.json` read that hangs;
- no output admission (helpers placed in `bin/` never run);
- tool errors, throws and denials returned once;
- ledger write failure, and a ledger write that hangs;
- the off switch, and no executable run by bare name.

`extensions/` tests cover the same rules through Pi's handlers. They also cover the extension
entrypoint with the off switch, the process runner's deadline, process group, output bound and
UTF-8 decoding, and the Pi-only tool changes.

## Live check: coverage and rewrites

Use a disposable account or session with tool-gateway installed and RTK configured as in the
[README](../../README.md#1-configure-rtk). On each host:

1. Note the newest ledger file, then make 20 distinct shell calls in the main thread and 20 in
   one subagent. Avoid calls that never reach the shell.
2. Count the rows the session added:

   ```bash
   jq -s 'map(select(.session == "<session id>")) | {rows: length,
     bash: map(select(.tool == "Bash" or .tool == "bash")) | length,
     applied: map(select(.rewrite == "applied")) | length,
     reasons: (map(.rewrite_reason // empty) | group_by(.) | map({(.[0]): length}) | add)}' \
     ~/.claude/context-economy/gateway-ledger/*.jsonl      # Pi: gateway-ledger-pi/
   ```

3. Count the shell calls in the session's transcript. Every one must have a row (100% coverage).
   Report the applied count and the reasons as they are: not every command has an RTK
   equivalent.
4. Record `rtk gain` before and after. It is RTK's report of what its rewrites saved; the
   ledger's byte fields are not a measure of savings.

## Live check: latency

From the same rows, report the 90th percentile of `ms_rewrite` for shell calls:

```bash
jq -s '[.[] | select(.tool == "Bash" or .tool == "bash") | .ms_rewrite] | sort | .[(length * 0.9 | floor)]' \
  ~/.claude/context-economy/gateway-ledger/*.jsonl
```

It must be below 100 ms. A first call includes `--version` and may be slower.

## Live check: RTK's own hook alongside

RTK can also be set up through its own Claude Code hook (`rtk init -g`). With both enabled, RTK's
hook may rewrite a command before the gateway sees it. `rtk rewrite` leaves an `rtk …` command
unchanged, so the command is not rewritten twice, but each may still start an RTK process.
Record the command that ran (from the transcript) and the ledger row for a few calls, with the
RTK version used.
