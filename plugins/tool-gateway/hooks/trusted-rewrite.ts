// SPDX-License-Identifier: Apache-2.0

import { within } from "./bounded.ts";
import { REWRITE_GRACE_MS } from "./config.ts";
import { deadlineIn, leftMs } from "./exec-trust.ts";
import type { ExecDeps } from "./exec-trust.ts";
import { rewriteWith } from "./rewrite.ts";
import { checkRtk } from "./rtk-trust.ts";
import type { Trust } from "./rtk-trust.ts";
import { bindRtk } from "./shell-grammar.ts";
import type { GatewayConfig, Ports, RewriteOutcome } from "./types.ts";

/** Host capabilities for one rewrite; each host builds them from its own runtime. */
export type RewriteDeps = {
  ports: Ports;
  cfg: GatewayConfig;
  trust: Trust;
  /** Host realpath; undefined when the path leads nowhere. */
  realPath: ExecDeps["realPath"];
  /** `CE_RTK_BIN` as the host sees it, read inside the budget. */
  envBin: () => Promise<string | undefined> | string | undefined;
  /** Text of `~/.claude/context-economy/config.json`; undefined when absent. */
  readConfig: () => Promise<string | undefined>;
};

/**
 * Shared by both hosts: rewrite only through the verified executable, and only output the
 * grammar accepts. One deadline (a 1 s budget) covers the trust check, `--version` on a first
 * check, and the rewrite. Reads with no timeout of their own (the environment, config.json,
 * realpath) are bounded too: past the budget and `REWRITE_GRACE_MS` the original command
 * runs, and the abandoned check changes no trust state when it ends.
 */
export async function trustedRewrite(deps: RewriteDeps, original: string): Promise<RewriteOutcome> {
  const { ports, cfg } = deps;
  const started = ports.nowMs();
  let current = true;
  return within(ports, cfg.rewriteTimeoutMs + REWRITE_GRACE_MS, rewriteOnce(deps, original, started, () => current), () => {
    current = false;
    return { command: original, status: "error", ms: ports.nowMs() - started, reason: "rewrite_budget" };
  });
}

async function rewriteOnce(
  deps: RewriteDeps,
  original: string,
  started: number,
  isCurrent: () => boolean,
): Promise<RewriteOutcome> {
  const { ports, cfg } = deps;
  const exec: ExecDeps = { run: ports.run, realPath: deps.realPath, nowMs: ports.nowMs };
  const deadline = deadlineIn(exec, cfg.rewriteTimeoutMs);
  const verdict = await checkRtk(
    deps.trust,
    { exec, envBin: deps.envBin, readConfig: deps.readConfig, isCurrent },
    deadline,
  );
  if (!verdict.ok) {
    if (verdict.isNew && isCurrent()) {
      try {
        ports.status(`tool-gateway: RTK rewrite off (${verdict.reason}: ${verdict.detail})`);
      } catch {
        // A status display failure must not prevent the tool call.
      }
    }
    return { command: original, status: "off", ms: ports.nowMs() - started, reason: verdict.reason };
  }
  const raw = await rewriteWith(ports, cfg, verdict.path, original, leftMs(exec, deadline));
  const ms = ports.nowMs() - started;
  // A rewrite answered after the budget is not used, whatever the host's timeout did.
  if (leftMs(exec, deadline) < 0) return { command: original, status: "error", ms, reason: "rewrite_budget" };
  if (raw.status !== "applied") return { ...raw, ms };
  const bound = bindRtk(raw.command, verdict.path);
  if (!bound.ok) return { command: original, status: "error", ms, reason: `grammar: ${bound.reason}` };
  return { command: bound.command, status: "applied", ms };
}
