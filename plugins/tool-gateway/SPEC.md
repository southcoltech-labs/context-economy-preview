# tool-gateway specification

This is the one contract for tool-gateway on both hosts: the Claude Code plugin
(`plugins/tool-gateway/`) and the Pi extension (`extensions/tool-gateway/`). The host-neutral core
lives in `plugins/tool-gateway/hooks/`, and the Pi extension imports it from there.

| Module | Holds |
| --- | --- |
| `hooks/register.ts` | Claude Code wiring: one `tool.call` hook for every tool |
| `extensions/tool-gateway/index.ts`, `register.ts`, `io.ts` | Pi wiring: `tool_call` and `tool_result` handlers, Node file and process ports |
| `hooks/trusted-rewrite.ts` | One rewrite: trust check, `rtk rewrite`, grammar binding, all inside one budget |
| `hooks/rtk-trust.ts`, `hooks/exec-trust.ts` | Where RTK comes from, and how it is checked |
| `hooks/rewrite.ts` | Running `rtk rewrite` and reading its answer |
| `hooks/shell-grammar.ts` | The grammar a rewrite must fit, and binding `rtk` to the checked path |
| `hooks/ledger.ts` | Ledger rows and segments |
| `hooks/bounded.ts` | Waiting for work that may never answer |
| `hooks/config.ts`, `hooks/types.ts` | Constants and shared types |
| `extensions/shared/process.ts` | Pi's process runner: deadline, process group, output bound |
| `extensions/tool-gateway/sequential.ts`, `loadout.ts` | Pi-only tool changes |

## Configuration

- **RTK path.** From the environment variable `CE_RTK_BIN` if it is set and not empty, else from
  `rtk.path` in `~/.claude/context-economy/config.json`. It must be absolute. `PATH` is never
  searched, and no executable is ever run by bare name.
- **Off switch.** `CE_TOOL_GATEWAY=off` turns the gateway off: the hosts' tools run as if it were
  not installed and no ledger row is written. On Pi it also skips the `edit`/`write` overrides
  and the loadout trim (below).

## Rewrite

Only shell commands are rewritten: Claude Code `Bash`, Pi `bash`. A Claude Code
`run_in_background` call is never rewritten (ledger status `background`): RTK holds output until
the command exits, so the live log would stay empty.

For each command, in this order:

1. **Trust check** (below). If it fails, the original command runs.
2. **`<path> rewrite <command>`**, where `<path>` is the checked real path. Its answer is used
   only when it exits `0` or `3` and prints a non-empty command that differs from the original.
   Exit `1` with empty output means RTK has no equivalent (`none`). Output the host cut short
   (`isStdoutTruncated`) is never used (`rewrite_truncated`): a cut answer can look like a
   shorter valid command. Anything else is an `error`.
3. **Grammar binding.** The answer must fit this grammar, or the original command runs:
   - simple commands of words, joined by `|`, `&&`, `||` or `;`;
   - a word is bare, single-quoted, or double-quoted with no `$`, backtick or backslash;
   - redirects are `<`, `>` and `>>` to a plain word, `2>&1`, and `2>` to `/dev/null` only;
   - a command word may not be a wrapper that runs its arguments (by name or path: `sh`, `bash`,
     `env`, `exec`, `xargs`, `sudo`, `timeout` and others), and may not carry unquoted `*?[]~`;
   - at least one command word is `rtk`.

   Each `rtk` in command position becomes the single-quoted checked path.

### One budget

The trust check, `--version` on a first check, and the rewrite share one 1 s deadline
(`REWRITE_TIMEOUT_MS`). Each subprocess gets only the time left, and an answer that arrives after
the deadline is not used, whatever the host's own timeout did.

Reads that have no timeout of their own (the environment, `config.json`, the host's realpath)
are bounded too. The whole rewrite returns by the deadline plus `REWRITE_GRACE_MS` (100 ms):
past that, the original command runs with reason `rewrite_budget`. The abandoned check keeps
running, since a host read cannot always be cancelled, but it changes no trust state when it
ends.

## Trust check

On the first use of a configured path:

1. The host resolves it (Claude Code `$.fs.stat` with `resolve`, Pi Node `realpath`).
2. `/usr/bin/uname -s` and `/usr/bin/id -u` run once per module life.
3. `/usr/bin/stat` reads the real path's type, mode, owner, device, inode, size and times
   (`-f '%p|%u|%d|%i|%z|%Fm|%Fc'` on macOS, `-c '%f|%u|%d|%i|%s|%y|%z'` on Linux). Other
   platforms are refused.
4. The file must be a regular file, owned by the user or root, and not writable by group or
   others.
5. `<real path> --version` must print `rtk X.Y.Z` with a version from 0.47.0 up to, not
   including, 1.0.0, in at most 4096 bytes.

The identity read in step 3 is kept. Before every later rewrite, steps 1 and 3 run again, and any
change of real path, device, inode, size, modification time, change time, owner or mode turns
rewriting off for that path for the rest of the module's life. So does a failed revalidation, a
timeout included.

Reason codes, in the ledger's `rewrite_reason` and in one status line (Claude Code) or
notification (Pi) per reason:

| Code | Meaning | Sticky for the path |
| --- | --- | --- |
| `rtk_unconfigured` | No `CE_RTK_BIN` and no `rtk.path` | No: checked again on the next call |
| `rtk_config_invalid` | `config.json` unreadable or not JSON, `rtk.path` not a string, or the path not absolute | No |
| `rtk_untrusted` | First check failed: not a regular file, wrong owner or mode, or `stat` failed | Yes |
| `rtk_version` | `--version` not RTK's, or outside the supported range | Yes |
| `rtk_changed` | Identity changed since the first check | Yes |
| `rtk_check_failed` | A revalidation failed or timed out | Yes |
| `rewrite_budget` | The budget ran out | No |
| `rewrite_truncated` | The host cut RTK's answer short | No |
| `rewrite_threw` | The rewrite threw | No |
| `grammar: <rule>` | The answer did not fit the grammar | No |

A module reload (Claude Code) or a new Pi session starts the trust state over.

## Processes

Claude Code runs processes through `$.process.run`, which caps each stream at 4 MiB and reports a
cut. Pi runs them through `extensions/shared/process.ts`:

- the child gets its own process group, and at the deadline the whole group gets `SIGKILL` and
  the call fails at once; output that arrives later is never returned;
- output is kept as bytes and decoded once, so a UTF-8 character split across reads stays whole;
- each stream is capped at 1 MiB (`OUTPUT_MAX_BYTES`): past it the group is killed and the call
  fails.

## Ledger

One row per tool call, every tool, main thread and subagents. Rows hold metadata only, never
command text or output:

```json
{"schema":"ce.claude-gateway.v1","ts":"<ISO>","session":"<id>","agent":"<agentId|main>",
 "tool":"Bash","tool_use_id":"...","rewrite":"applied|none|error|off|background",
 "rewrite_reason":"<code, optional>","cmd_in_bytes":0,"cmd_out_bytes":0,
 "admit":"off","admit_reason":"not in this release","out_bytes_before":0,"out_bytes_after":0,
 "is_error":false,"ms_rewrite":0,"ms_tool":0,"ms_admit":0}
```

| | Claude Code | Pi |
| --- | --- | --- |
| Schema | `ce.claude-gateway.v1` | `ce.pi-gateway.v1` |
| Folder | `~/.claude/context-economy/gateway-ledger/` | `~/.claude/context-economy/gateway-ledger-pi/` |
| Modes | The host's defaults (typically `0755`/`0644`): `$.fs` cannot set modes | Folder `0700`, files `0600` |
| Writing | The open segment is rewritten whole after each call | The same, through a temporary file and a rename |

- Files are segments named `<session>-<startMs>-0.jsonl` of at most 200 rows
  (`LEDGER_SEGMENT_ROWS`). A reload starts a new segment, so no file is overwritten by a second
  module instance.
- `admit` fields are part of the row format and fixed: this release never changes tool output.
  On Claude Code a call whose tool threw records `admit: "skipped"`, `admit_reason: "tool_threw"`.
- `out_bytes_before` and `out_bytes_after` are the result's stdout bytes (Claude Code) or text
  bytes (Pi), and are always equal. They are not what the output would have been without RTK.
- A ledger write, the Claude session-id lookup included, holds a tool result for at most 500 ms
  (`LEDGER_BUDGET_MS`). A failed write is reported once, and the tool result is returned
  unchanged.
- Rows are never pruned.

## Pi-only tool changes

- **Sequential file tools.** Pi runs the tool calls of one message in parallel unless one of them
  is sequential. The extension re-registers the built-in `edit` and `write` with
  `executionMode: "sequential"`, so a batch that holds one runs in order and a check sent with
  an edit sees it.
- **Loadout trim.** At `session_start` it deactivates `bg_task`, `bg_status`, `bg_task_list` and
  `bg_task_watch` if another package registered them: they duplicate single-purpose tools and add
  their schemas to every request. They stay registered; `setActiveTools` or `--tools` turns them
  back on.

## Failure classes

| Operation | Class | On failure |
| --- | --- | --- |
| Trust check, revalidation | F2: guards the rewrite only | No rewrite; the original command runs once; one status line or notification per reason |
| `rtk rewrite`, grammar binding | F1 | The original command runs once. Pi's `tool_call` handler never throws: a throw would block the tool |
| Ledger write, status line | F1 | The tool result is returned untouched |
| `edit`/`write` re-registration, loadout trim (Pi) | F1 | The built-in tool runs as Pi defines it |
| The tool itself | F3 | Its result or error is returned once, never retried |

## Acceptance

Automated, on every change (CI runs both on macOS and Linux):

```bash
claude plugin validate . --strict
claude plugin test plugins/tool-gateway
bun test extensions
```

Live checks are in [TESTPLAN.md](TESTPLAN.md).
