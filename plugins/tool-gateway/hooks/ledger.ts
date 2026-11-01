// SPDX-License-Identifier: Apache-2.0

import { LEDGER_SEGMENT_ROWS } from "./config.ts";
import type { GatewayConfig, LedgerRow, Ports } from "./types.ts";

type Segment = { path: string; rows: LedgerRow[] };

const segments = new Map<string, Segment>();
let writes: Promise<void> = Promise.resolve();
let reportedFailure = false;
let lastSegmentStartMs = 0;

/** Persist one privacy-filtered row. Errors stay out of the tool call path. */
export function appendLedger(ports: Ports, cfg: GatewayConfig, row: LedgerRow): Promise<void> {
  if (!cfg.enabled) return Promise.resolve();
  const next = writes.then(() => append(ports, cfg, row));
  writes = next.catch(() => undefined);
  return next.catch(async () => {
    if (reportedFailure) return;
    reportedFailure = true;
    try {
      ports.status("tool-gateway: ledger write failed; tool call continues");
    } catch {
      // Ledger reporting is best effort and must never block the tool call.
    }
  });
}

async function append(ports: Ports, cfg: GatewayConfig, row: LedgerRow): Promise<void> {
  const key = `${cfg.ledgerPath}\0${row.session}`;
  let segment = segments.get(key);
  if (!segment || segment.rows.length >= LEDGER_SEGMENT_ROWS) {
    segment = await newSegment(ports, cfg.ledgerPath, row.session);
    segments.set(key, segment);
  }
  segment.rows.push(privacySafeRow(row));
  const body = `${segment.rows.map(value => JSON.stringify(value)).join("\n")}\n`;
  await ports.writeFile(segment.path, body);
}

async function newSegment(ports: Ports, directory: string, session: string): Promise<Segment> {
  const startMs = Math.max(ports.nowMs(), lastSegmentStartMs + 1);
  lastSegmentStartMs = startMs;
  const safeSession = encodeURIComponent(session || "unknown").replaceAll("%", "_");
  const path = `${directory}/${safeSession}-${startMs}-0.jsonl`;
  return { path, rows: [] };
}

function privacySafeRow(row: LedgerRow): LedgerRow {
  return {
    schema: row.schema,
    ts: row.ts,
    session: row.session,
    agent: row.agent,
    tool: row.tool,
    tool_use_id: row.tool_use_id,
    rewrite: row.rewrite,
    // A fixed reason code (trust or grammar), never command text.
    ...(row.rewrite_reason ? { rewrite_reason: row.rewrite_reason } : {}),
    cmd_in_bytes: row.cmd_in_bytes,
    cmd_out_bytes: row.cmd_out_bytes,
    admit: row.admit,
    admit_reason: row.admit_reason,
    out_bytes_before: row.out_bytes_before,
    out_bytes_after: row.out_bytes_after,
    is_error: row.is_error,
    ms_rewrite: row.ms_rewrite,
    ms_tool: row.ms_tool,
    ms_admit: row.ms_admit,
  };
}
