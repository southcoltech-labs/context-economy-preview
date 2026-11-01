// SPDX-License-Identifier: Apache-2.0

import type { GatewayConfig, Ports, RewriteOutcome } from "./types.ts";

/**
 * Runs `<executable> rewrite <command>`; any failure keeps the original command. `timeoutMs` is
 * what is left of the caller's rewrite budget (default: the whole budget).
 */
export async function rewriteWith(
  ports: Ports,
  cfg: GatewayConfig,
  executable: string,
  command: string,
  timeoutMs: number = cfg.rewriteTimeoutMs,
): Promise<RewriteOutcome> {
  if (!cfg.enabled) return { command, status: "off", ms: 0 };
  const started = ports.nowMs();
  if (timeoutMs <= 0) return { command, status: "error", ms: 0, reason: "rewrite_budget" };
  try {
    const result = await ports.run([executable, "rewrite", command], { timeoutMs });
    const elapsed = ports.nowMs() - started;
    // Cut output could be a shorter command that grammar accepts, dropping the rest.
    if (result.isStdoutTruncated) return { command, status: "error", ms: elapsed, reason: "rewrite_truncated" };
    const rewritten = result.stdout.trim();
    if (
      (result.exitCode === 0 || result.exitCode === 3) &&
      rewritten.length > 0 &&
      rewritten !== command
    ) {
      return { command: rewritten, status: "applied", ms: elapsed };
    }
    if (result.exitCode === 1 && rewritten.length === 0) {
      return { command, status: "none", ms: elapsed };
    }
    return {
      command,
      status: result.exitCode === 0 || result.exitCode === 3 ? "none" : "error",
      ms: elapsed,
    };
  } catch {
    return { command, status: "error", ms: ports.nowMs() - started };
  }
}
