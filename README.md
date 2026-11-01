# context-economy

> **Staging repository.** If you are reading this at `southcoltech-labs/context-economy-preview`, this is the staging repository for release drills, not an install source. Its tags are drills. Install from `southcoltech-labs/context-economy`, as below. (This note is removed before `southcoltech-labs/context-economy` is published.)

Plugins for Claude Code and extensions for Pi that cut context cost. The first one is:

| Plugin | What it does | Claude Code | Pi |
| --- | --- | --- | --- |
| [tool-gateway](plugins/tool-gateway/) | Rewrites shell commands through a verified RTK executable and keeps a metadata-only ledger of tool calls | Yes | Yes |

It starts no network connection or model call of its own. See [SECURITY.md](SECURITY.md) for what it reads, writes and runs, and what stays on disk.

## What it changes in each host

- **Both hosts.** Before a shell command runs, tool-gateway asks RTK for a shorter-output equivalent (`rtk rewrite`) and runs that instead, with `rtk` bound to the verified path. If RTK is not configured or not trusted, answers late, or answers with anything outside a strict shell grammar, the original command runs. Every tool call adds one ledger row of metadata: names, ids, statuses, byte counts and timings, never command text or output.
- **Claude Code.** Permission rules see the rewritten command, so a rule such as `Bash(git status:*)` no longer matches it and Claude Code asks for approval. Background Bash calls are never rewritten.
- **Pi.** Besides the rewrite and the ledger, the extension:
  - re-registers the built-in `edit` and `write` tools as sequential, so a batch that holds one runs in order (a test sent with an edit sees the edit);
  - at session start, deactivates the tools `bg_task`, `bg_status`, `bg_task_list` and `bg_task_watch` if another package registered them (they duplicate single-purpose tools and add their schemas to every request). They stay registered; `setActiveTools` or `--tools` turns them back on.

`CE_TOOL_GATEWAY=off` turns all of this off, on both hosts.

**What the ledger does not measure.** Output is never shortened after a tool runs, so each row's `out_bytes_before` equals its `out_bytes_after`. Neither is what the output would have been without RTK, so the ledger is not a measure of savings. RTK's own `rtk gain` reports what its rewrites saved.

**RTK's own integrations.** RTK has its own setup for both hosts (`rtk init -g` for Claude Code, `rtk init -g --agent pi` for Pi). If you only want shorter command output, that is the simpler choice. tool-gateway adds: RTK only from an absolute path you name, checked before every use; a strict grammar for what a rewrite may run; one metadata-only ledger across both hosts; and releases that are checked on both hosts before they reach the `release` channel. The output reduction itself is RTK's.

**Status: pre-release.** No version has been released yet. The steps below are what the first release is checked against, on both hosts, before it is published.

## Supported environment

| Item | Supported |
| --- | --- |
| OS | macOS on Apple silicon (arm64), Linux x86_64. Windows is not supported |
| Hosts | Claude Code (tested with 2.1.310), Pi (tested with 1.0.2) |
| RTK | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) 0.47.0 or later, below 1.0.0, at an absolute path you name |

## 1. Configure RTK

RTK is never looked up on `PATH`. It must be an absolute path to a file owned by you or root that group and others cannot write; tool-gateway checks this with the system `stat` before every use. Without a trusted RTK, tool-gateway records its ledger and rewrites nothing.

**RTK 0.47.0.** Paste this block as a whole. It runs in a subshell that stops at the first failure: an unsupported platform, a failed download, a missing checksum entry or a checksum mismatch ends it before anything is unpacked or run.

```bash
(
  set -eu
  v=0.47.0
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) asset=rtk-aarch64-apple-darwin.tar.gz; verify() { shasum -a 256 -c -; } ;;
    Linux-x86_64) asset=rtk-x86_64-unknown-linux-musl.tar.gz; verify() { sha256sum -c -; } ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$HOME/.local/opt/rtk-$v"
  cd "$HOME/.local/opt/rtk-$v"
  curl -fsSLO "https://github.com/rtk-ai/rtk/releases/download/v$v/$asset"
  curl -fsSLO "https://github.com/rtk-ai/rtk/releases/download/v$v/checksums.txt"
  line=$(grep -E "^[0-9a-f]{64}  $asset\$" checksums.txt) || { echo "no checksum for $asset" >&2; exit 1; }
  printf '%s\n' "$line" | verify
  tar -xzf "$asset" rtk
  chmod 755 rtk
  ./rtk --version
  echo "rtk.path: $HOME/.local/opt/rtk-$v/rtk"
)
```

It must end by printing `rtk 0.47.0` and the path to put in `rtk.path`. A different program also called `rtk` (reachingforthejack/rtk) exists; the version check refuses it.

**Name the path** in `~/.claude/context-economy/config.json`, which both hosts read. It must be absolute; `~` is not expanded:

```json
{
  "rtk": { "path": "/Users/you/.local/opt/rtk-0.47.0/rtk" }
}
```

The environment variable `CE_RTK_BIN` takes precedence over the file. In Claude Code, set it under `env` in `~/.claude/settings.json`; for Pi, export it in the shell that starts Pi.

## 2. Install

**Claude Code:**

```bash
claude plugin marketplace add southcoltech-labs/context-economy#release
claude plugin install tool-gateway@context-economy
```

Restart Claude Code. `#release` is the stable channel: it only ever moves to a version that passed the release checks.

**Pi:**

```bash
pi install git:github.com/southcoltech-labs/context-economy@release
```

Pi loads the tool-gateway extension from the package. Restart Pi.

## 3. Update

Run these to move to the newest released version:

**Claude Code:**

```bash
claude plugin marketplace update context-economy
claude plugin update tool-gateway@context-economy
```

**Pi:** `pi update --extensions` (plain `pi update` updates only Pi itself).

Restart the host after updating.

## 4. Roll back to an earlier version

Every released version has a tag `promoted-v<version>`; see the [releases](https://github.com/southcoltech-labs/context-economy/releases). Use only those tags.

**Claude Code** (one marketplace per name, so it is replaced):

```bash
claude plugin marketplace remove context-economy      # also uninstalls its plugin
claude plugin marketplace add southcoltech-labs/context-economy#promoted-v<version>
claude plugin install tool-gateway@context-economy
```

**Pi:**

```bash
pi install git:github.com/southcoltech-labs/context-economy@promoted-v<version>
```

The tag stays pinned: updates do not move it. To return to updates, repeat the steps with `#release` (Claude Code) or `@release` (Pi).

Your data is kept across rollback, update and uninstall: the gateway ledgers and `config.json` live under `~/.claude/context-economy/` (see [SECURITY.md](SECURITY.md)), not in the hosts' plugin folders. A release that changes a stored format says so in its release notes, with what rolling back below it means.

## 5. Turn off or uninstall

- **Turn off the gateway:** set `CE_TOOL_GATEWAY=off` (Claude Code `settings.json` `env`, or the shell for Pi), then restart. On Pi this also leaves `edit`, `write` and the background tools as Pi and their packages define them. Removing `rtk.path` and `CE_RTK_BIN` stops rewriting but keeps the ledger.
- **Disable (Claude Code):** `claude plugin disable tool-gateway@context-economy`.
- **Uninstall (Claude Code):** `claude plugin uninstall tool-gateway@context-economy`, or remove everything with `claude plugin marketplace remove context-economy`.
- **Uninstall (Pi):** `pi remove git:github.com/southcoltech-labs/context-economy` (with or without the `@…` you installed).

Uninstalling leaves your data in place: in `~/.claude/context-economy/`, the folders `gateway-ledger/` and `gateway-ledger-pi/` and the file `config.json`. To delete it, remove them yourself.

## Layout

- `plugins/`: Claude Code plugins, listed in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json).
- `extensions/`: Pi extensions, listed in the `pi` field of [`package.json`](package.json). They import the shared core from `plugins/`.
- `scripts/`, `.changeset/`, `.github/workflows/`: release tooling.

## Development

```bash
npm ci
npm run -s test:tooling                        # release tooling
npm run -s version:check                       # manifests share one version
claude plugin validate . --strict
claude plugin test plugins/tool-gateway
bun test extensions                            # Pi extension
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the toolchain, type checking and how changes are released.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Report security issues as described in [SECURITY.md](SECURITY.md).
