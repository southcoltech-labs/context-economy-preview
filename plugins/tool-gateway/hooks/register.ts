// SPDX-License-Identifier: Apache-2.0

import type { Hook, Register, ToolCallInput, ToolCallResult } from "claude-code";
import { within } from "./bounded.ts";
import { ADMIT_OFF_REASON, CONFIG_FILE, LEDGER_BUDGET_MS, LEDGER_DIRECTORY, gatewayConfig } from "./config.ts";
import { appendLedger } from "./ledger.ts";
import { createTrust } from "./rtk-trust.ts";
import { trustedRewrite } from "./trusted-rewrite.ts";
import type {
  GatewayConfig,
  LedgerRow,
  Ports,
  RewriteOutcome,
} from "./types.ts";

const encoder = new TextEncoder();
let reportedHomeMissing = false;
/** Module life = one verification per configured path; a reload verifies again. */
const trust = createTrust();

export const register: Register = on => {
  on("tool.call", async ($, e, next) => {
    let home: string | undefined;
    let flag: string | undefined;
    try {
      [home, flag] = await Promise.all([
        $.env.get("HOME"),
        $.env.get("CE_TOOL_GATEWAY"),
      ]);
    } catch {
      return next(e);
    }
    const ports = makePorts($);
    const cfg = gatewayConfig({ home, flag, host: "claude" });
    if (!cfg.enabled) {
      if (cfg.disabledReason && !reportedHomeMissing) {
        reportedHomeMissing = true;
        try {
          ports.status(`tool-gateway off: ${cfg.disabledReason}`);
        } catch {
          // A status display failure must not prevent the tool call.
        }
      }
      return next(e);
    }

    const isBash = e.tool === "Bash";
    const original = isBash ? e.command : "";
    let rewrite: RewriteOutcome = { command: original, status: "off", ms: 0 };
    const started = ports.nowMs();
    // rtk holds all output until the command exits, so a rewritten background
    // command would show an empty live log (dev servers, followers).
    if (isBash && e.run_in_background === true) {
      rewrite = { command: original, status: "background", ms: 0 };
    } else if (isBash) {
      try {
        rewrite = await claudeRewrite($, ports, cfg, home as string, original);
      } catch {
        // F1: a rewrite failure runs the original command.
        rewrite = { command: original, status: "error", ms: ports.nowMs() - started, reason: "rewrite_threw" };
      }
    }
    let result: ToolCallResult | undefined;
    let didThrow = false;
    let thrownValue: unknown;
    let toolMs = 0;
    try {
      result = await next(isBash ? { ...e, command: rewrite.command } : e);
      toolMs = ports.nowMs() - started - rewrite.ms;
    } catch (error) {
      didThrow = true;
      thrownValue = error;
      toolMs = ports.nowMs() - started - rewrite.ms;
    } finally {
      // Ledger failures, or a ledger that never answers, must not replace or hold the result.
      const persist = async () => {
        let session = "unknown";
        try { session = await $.session.id(); } catch { /* ledger is best effort */ }
        await appendLedger(ports, cfg, await ledgerRow(cfg, e, rewrite, toolMs, result, session, didThrow));
      };
      try {
        await within(ports, LEDGER_BUDGET_MS, persist(), () => undefined);
      } catch {
        // As above.
      }
    }
    if (didThrow) throw thrownValue;
    return result as ToolCallResult;
  });
};

/** Rewrite through the shared core (trusted-rewrite.ts), with the Claude host's realpath and files. */
async function claudeRewrite(
  $: Parameters<Hook>[0],
  ports: Ports,
  cfg: GatewayConfig,
  home: string,
  original: string,
): Promise<RewriteOutcome> {
  return trustedRewrite({
    ports,
    cfg,
    trust,
    realPath: async (path: string) => (await $.fs.stat(path, { resolve: true })).realPath,
    envBin: () => $.env.get("CE_RTK_BIN"),
    readConfig: async () => {
      const path = `${home.replace(/\/$/, "")}/${LEDGER_DIRECTORY}/${CONFIG_FILE}`;
      return (await $.fs.exists(path)) ? $.fs.read(path) : undefined;
    },
  }, original);
}

async function ledgerRow(
  cfg: GatewayConfig,
  event: ToolCallInput,
  rewrite: RewriteOutcome,
  toolMs: number,
  result: ToolCallResult | undefined,
  session: string,
  toolThrew: boolean,
): Promise<LedgerRow> {
  const stdout = !toolThrew && event.tool === "Bash" && result
    ? stdoutOf(result as ToolCallResult<"Bash">)
    : "";
  const originalBytes = event.tool === "Bash" ? encoder.encode(event.command).length : 0;
  const outputBytes = encoder.encode(stdout).length;
  const failed = toolThrew || (result !== undefined && (
    "deny" in result || result.isError === true
  ));
  return {
    schema: cfg.schema,
    ts: new Date().toISOString(),
    session,
    agent: event.agentId || "main",
    tool: event.tool,
    tool_use_id: event.tool_use_id || "",
    rewrite: rewrite.status,
    ...(rewrite.reason ? { rewrite_reason: rewrite.reason } : {}),
    cmd_in_bytes: originalBytes,
    cmd_out_bytes: event.tool === "Bash" ? encoder.encode(rewrite.command).length : 0,
    admit: toolThrew ? "skipped" : "off",
    admit_reason: toolThrew ? "tool_threw" : ADMIT_OFF_REASON,
    out_bytes_before: outputBytes,
    out_bytes_after: outputBytes,
    is_error: failed,
    ms_rewrite: rewrite.ms,
    ms_tool: Math.max(0, toolMs),
    ms_admit: 0,
  };
}

function makePorts($: Parameters<Hook>[0]): Ports {
  return {
    run: (argv, init) => $.process.run(argv, init),
    writeFile: (path, text) => $.fs.write(path, text),
    status: text => { void $.ui.status(text); },
    nowMs: () => Date.now(),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  };
}

function stdoutOf(result: ToolCallResult<"Bash">): string {
  if (!("result" in result) || !result.result || typeof result.result !== "object") return "";
  const stdout = (result.result as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}
