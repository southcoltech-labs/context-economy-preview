// SPDX-License-Identifier: Apache-2.0

/** Pi-only constants. Shared thresholds, timeouts and host profiles live in the Claude mod's config.ts. */
export const BASH_TOOL = 'bash'
export const TEXT_BLOCK_TYPE = 'text'
export const TOOL_CALL_EVENT = 'tool_call'
export const TOOL_RESULT_EVENT = 'tool_result'
export const DEFAULT_AGENT = 'main'
export const UNKNOWN_SESSION = 'unknown'
export const LEDGER_FILE_MODE = 0o600
export const LEDGER_DIR_MODE = 0o700
export const STATUS_KEY = 'tool-gateway'
/** Built-in tools that change files. A batch holding one of these runs in order, so a check in the same batch sees the change. */
export const FILE_MUTATING_TOOLS: readonly string[] = ['edit', 'write']
export const SEQUENTIAL_MODE = 'sequential'
/**
 * Tools deactivated at session start to cut per-request schema tokens. pi-better-background-tasks
 * wrappers and extras: measured +8.3k input tokens per request with all 8 bg tools, +2.6k with
 * spawn/status/log/stop only (deepseek-flash, 2026-10-07). Claude parity: Bash background + TaskStop.
 */
export const INACTIVE_TOOLS: readonly string[] = ['bg_task', 'bg_status', 'bg_task_list', 'bg_task_watch']
