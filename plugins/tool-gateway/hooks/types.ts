// SPDX-License-Identifier: Apache-2.0

/** Host-neutral gateway types. Host-specific shapes live in the host adapters. */
export type Ports = {
  run(
    argv: readonly string[],
    init?: { stdin?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    isStdoutTruncated?: boolean;
  }>;
  writeFile(path: string, text: string): Promise<void>;
  status(text: string | undefined): void;
  nowMs(): number;
  /** Resolves after `ms`; rejects at once when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};
export type GatewayHost = "claude" | "pi";
export type LedgerSchema = "ce.claude-gateway.v1" | "ce.pi-gateway.v1";
export type GatewayConfig = {
  enabled: boolean;
  disabledReason?: string;
  schema: LedgerSchema;
  ledgerPath: string;
  rewriteTimeoutMs: number;
};
/** "background": a run_in_background call, never rewritten (rtk holds output until exit). */
export type RewriteStatus = "applied" | "none" | "error" | "off" | "background";
export type AdmitStatus = "admitted" | "passthrough" | "skipped" | "error" | "off";
export type LedgerRow = {
  schema: LedgerSchema;
  ts: string;
  session: string;
  agent: string;
  tool: string;
  tool_use_id: string;
  rewrite: RewriteStatus;
  /** Claude host: why rewrite was off or rejected; absent when applied or not attempted. */
  rewrite_reason?: string;
  cmd_in_bytes: number;
  cmd_out_bytes: number;
  admit: AdmitStatus;
  admit_reason: string;
  out_bytes_before: number;
  out_bytes_after: number;
  is_error: boolean;
  ms_rewrite: number;
  ms_tool: number;
  ms_admit: number;
};
/** `reason`: why a rewrite was not applied (trust or grammar), for the ledger. */
export type RewriteOutcome = { command: string; status: RewriteStatus; ms: number; reason?: string };
