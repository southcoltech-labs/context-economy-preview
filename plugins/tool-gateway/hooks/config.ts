// SPDX-License-Identifier: Apache-2.0

import type { GatewayConfig, GatewayHost, LedgerSchema } from "./types.ts";

export const LEDGER_DIRECTORY = ".claude/context-economy";
/** Per-host ledger schema and segment directory. The Claude values are the original ones. */
export const HOST_PROFILES: Record<GatewayHost, { schema: LedgerSchema; segmentDirectory: string }> = {
  claude: { schema: "ce.claude-gateway.v1", segmentDirectory: "gateway-ledger" },
  pi: { schema: "ce.pi-gateway.v1", segmentDirectory: "gateway-ledger-pi" },
};
export const LEDGER_SEGMENT_ROWS = 200;
export const REWRITE_TIMEOUT_MS = 1000;
/**
 * The rewrite as a whole returns by `REWRITE_TIMEOUT_MS` plus this, even when a read with no
 * timeout of its own hangs (config.json, realpath, the environment). Subprocesses keep the 1 s.
 */
export const REWRITE_GRACE_MS = 100;
/** Writing a ledger row, the session id lookup included, delays a tool result by at most this. */
export const LEDGER_BUDGET_MS = 500;
export const CONFIG_FILE = "config.json";
export const ADMIT_OFF_REASON = "not in this release";

export function gatewayConfig(input: {
  home: string | undefined;
  flag: string | undefined;
  host: GatewayHost;
}): GatewayConfig {
  const { flag: switchValue, home, host } = input;
  const profile = HOST_PROFILES[host];
  if (!profile) throw new Error(`unknown gateway host: ${String(host)}`);
  const root = home?.trim();
  if (!root) {
    return {
      enabled: false,
      disabledReason: "home_missing",
      schema: profile.schema,
      ledgerPath: "",
      rewriteTimeoutMs: REWRITE_TIMEOUT_MS,
    };
  }
  const configDirectory = `${root.replace(/\/$/, "")}/${LEDGER_DIRECTORY}`;
  // Public preview, both hosts: no output admission, as its helpers have no public
  // source; the config names no helper, so helpers placed in bin/ change nothing.
  return {
    enabled: switchValue !== "off",
    schema: profile.schema,
    ledgerPath: `${configDirectory}/${profile.segmentDirectory}`,
    rewriteTimeoutMs: REWRITE_TIMEOUT_MS,
  };
}
