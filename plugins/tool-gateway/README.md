# tool-gateway

Shell commands go through [RTK](https://github.com/rtk-ai/rtk), which shortens their output before it reaches the context. The gateway runs only an RTK you named and it verified. It also keeps a metadata-only ledger of tool calls. Claude Code plugin and Pi extension; same rules on both.

## What it does

- Before each shell command (Claude Code `Bash`, Pi `bash`), asks the verified RTK for a shorter equivalent (`rtk rewrite`) and runs that instead. Every `rtk` in the result becomes the quoted absolute path that was checked. Background commands are never rewritten.
- Before every rewrite, checks the RTK file with the system `stat`: a regular file owned by you or root, not writable by group or others, and unchanged since the session's first check. Its `--version` must be 0.47.0 or later, below 1.0.0. One 1 s budget covers the check and the rewrite, and the whole rewrite gives up after 1.1 s even if a file read hangs.
- Runs the original command whenever anything is off: no RTK configured, a failed check, a slow or failing rewrite, or output outside the accepted shell grammar.
- Writes one ledger row per tool call: session id, tool name, tool-use id, rewrite status and reason code, byte counts and timings. Never command text or output.

It does not change tool output. Output admission is not in this release.

## Setup

Install and configure RTK as in the [main README](../../README.md#1-configure-rtk): `rtk.path` in `~/.claude/context-economy/config.json`, or `CE_RTK_BIN`. The gateway never searches `PATH`.

## Common questions

- **A command I had allowed now asks for approval (Claude Code).** Permission rules see the rewritten command, so `Bash(git status:*)` does not match `'/…/rtk' git status`. This is expected. Do not add a blanket allow for RTK commands. To avoid the prompts, turn the gateway off or remove the RTK path.
- **Nothing is rewritten.** The status line, or a Pi notification, says why once per reason:
  - `rtk_unconfigured`: no path set;
  - `rtk_untrusted`: owner or mode;
  - `rtk_version`: for example RTK 1.x, which is not supported yet;
  - `rtk_changed`: the file changed during the session.

  The ledger's `rewrite_reason` has the same code.
- **Turn it off:** `CE_TOOL_GATEWAY=off`, then restart the host. On Pi this also undoes the extension's tool changes (see the [main README](../../README.md#what-it-changes-in-each-host)).

## It's working if

- A shell command such as `git status` runs as `'<your rtk path>' git status`, with RTK's shorter output.
- New rows appear in `~/.claude/context-economy/gateway-ledger/` (Claude Code) or `gateway-ledger-pi/` (Pi) with `"rewrite":"applied"`.

## Files

| File | Holds |
| --- | --- |
| `SPEC.md` | Behaviour, trust rules and failure classes, for both hosts |
| `TESTPLAN.md` | How the gateway is tested |
| `hooks/` | The Claude Code plugin and the shared core the Pi extension also uses (`trusted-rewrite.ts`, `rtk-trust.ts`, `exec-trust.ts`, `shell-grammar.ts`, `ledger.ts`, `bounded.ts`) |

For development, load it for one session with `claude --plugin-dir "$PWD/plugins/tool-gateway"`, or `pi -e "$PWD/extensions/tool-gateway/index.ts"`.
