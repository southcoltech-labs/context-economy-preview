// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "claude-code/testing";
import { appendLedger } from "./ledger.ts";
import type { GatewayConfig, LedgerRow, Ports } from "./types.ts";

const cfg: GatewayConfig = {
  enabled: true,
  schema: "ce.claude-gateway.v1",
  ledgerPath: "/tmp/gateway-ledger",
  rewriteTimeoutMs: 1000,
};

function row(id: number): LedgerRow {
  return {
    schema: "ce.claude-gateway.v1",
    ts: "2026-10-04T00:00:00.000Z",
    session: "session/id",
    agent: "main",
    tool: "Bash",
    tool_use_id: String(id),
    rewrite: "none",
    cmd_in_bytes: 10,
    cmd_out_bytes: 10,
    admit: "skipped",
    admit_reason: "below_min_bytes",
    out_bytes_before: 2,
    out_bytes_after: 2,
    is_error: false,
    ms_rewrite: 1,
    ms_tool: 2,
    ms_admit: 0,
  };
}

test("keeps JSONL segments bounded and writes only schema fields", async () => {
  const files = new Map<string, string>();
  let now = 100;
  const ports = {
    writeFile: async (path: string, text: string) => { files.set(path, text); },
    status: () => undefined,
    nowMs: () => now++,
  } as unknown as Ports;
  for (let i = 0; i < 201; i += 1) {
    const input = { ...row(i), command: "secret command", output: "secret output" } as unknown as LedgerRow;
    await appendLedger(ports, cfg, input);
  }
  expect(files.size).toBe(2);
  const entries = [...files.values()].map(text => text.trimEnd().split("\n"));
  expect(entries[0]).toHaveLength(200);
  expect(entries[1]).toHaveLength(1);
  expect(JSON.stringify(entries)).not.toContain("secret command");
  expect(JSON.stringify(entries)).not.toContain("secret output");
  expect(JSON.parse(entries[0][0])).toEqual(row(0));
});

test("a filesystem failure is reported once and never rejects", async () => {
  let statuses = 0;
  const ports = {
    writeFile: async () => { throw new Error("write failed"); },
    status: () => { statuses += 1; },
    nowMs: () => 1,
  } as unknown as Ports;
  await appendLedger(ports, cfg, row(1));
  await appendLedger(ports, cfg, row(2));
  expect(statuses).toBe(1);
});
