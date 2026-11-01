// SPDX-License-Identifier: Apache-2.0

/**
 * Pi wiring for the shared tool gateway: RTK rewrite on tool_call through the shared trust check,
 * and one metadata-only ledger row per call on tool_result. No output admission in
 * this release: a result is never replaced.
 */
import { within } from '../../plugins/tool-gateway/hooks/bounded'
import { ADMIT_OFF_REASON, LEDGER_BUDGET_MS } from '../../plugins/tool-gateway/hooks/config'
import { appendLedger } from '../../plugins/tool-gateway/hooks/ledger'
import type { Trust } from '../../plugins/tool-gateway/hooks/rtk-trust'
import { trustedRewrite } from '../../plugins/tool-gateway/hooks/trusted-rewrite'
import type { RewriteDeps } from '../../plugins/tool-gateway/hooks/trusted-rewrite'
import type { GatewayConfig, LedgerRow, Ports, RewriteOutcome } from '../../plugins/tool-gateway/hooks/types'
import { BASH_TOOL, DEFAULT_AGENT, TEXT_BLOCK_TYPE, TOOL_CALL_EVENT, TOOL_RESULT_EVENT, UNKNOWN_SESSION } from './config'

type Block = { type: string; text?: string }
type CallEvent = { toolCallId: string; toolName: string; input: Record<string, unknown> }
type ResultEvent = { toolCallId: string; toolName: string; content: Block[]; isError: boolean }
type Ctx = { sessionManager: { getSessionId(): string } }
type Pi = { on(event: string, handler: (event: never, ctx: Ctx) => unknown): unknown }
export type Deps = {
  cfg: GatewayConfig
  makePorts: (ctx: Ctx) => Ports
  /** RTK trust for this extension's life (a reload verifies again). */
  trust: Trust
  realPath: RewriteDeps['realPath']
  /** `CE_RTK_BIN`, read at each call. */
  envBin: () => string | undefined
  readConfig: RewriteDeps['readConfig']
}
type Pending = { rewrite: RewriteOutcome; cmdIn: number; startMs: number }

const encoder = new TextEncoder()
const bytes = (s: string): number => encoder.encode(s).length
const textBytes = (content: readonly Block[]): number =>
  content.reduce((n, b) => n + (b.type === TEXT_BLOCK_TYPE && typeof b.text === 'string' ? bytes(b.text) : 0), 0)

export function registerGateway(pi: Pi, deps: Deps): void {
  const { cfg } = deps
  const pending = new Map<string, Pending>()

  pi.on(TOOL_CALL_EVENT, async (event: CallEvent, ctx) => {
    // A throwing tool_call handler blocks the tool in Pi, so nothing here may throw.
    if (!cfg.enabled) return undefined
    const ports = deps.makePorts(ctx)
    const startMs = ports.nowMs()
    const command = event.input.command
    const isBash = event.toolName === BASH_TOOL && typeof command === 'string'
    let rewrite: RewriteOutcome = { command: isBash ? command : '', status: 'off', ms: 0 }
    if (isBash) {
      try {
        rewrite = await trustedRewrite({
          ports, cfg, trust: deps.trust, realPath: deps.realPath, envBin: deps.envBin, readConfig: deps.readConfig,
        }, command)
      } catch {
        // F1: a rewrite failure runs the original command.
        rewrite = { command, status: 'error', ms: ports.nowMs() - startMs, reason: 'rewrite_threw' }
      }
      if (rewrite.status === 'applied') event.input.command = rewrite.command
    }
    pending.set(event.toolCallId, { rewrite, cmdIn: isBash ? bytes(command) : 0, startMs })
    return undefined
  })

  pi.on(TOOL_RESULT_EVENT, async (event: ResultEvent, ctx) => {
    if (!cfg.enabled) return undefined
    try {
      const ports = deps.makePorts(ctx)
      const p = pending.get(event.toolCallId)
      pending.delete(event.toolCallId)
      let session = UNKNOWN_SESSION
      try { session = ctx.sessionManager.getSessionId() } catch { /* ledger is best effort */ }
      const out = textBytes(event.content ?? [])
      const row: LedgerRow = {
        schema: cfg.schema, ts: new Date(ports.nowMs()).toISOString(), session, agent: DEFAULT_AGENT,
        tool: event.toolName, tool_use_id: event.toolCallId,
        rewrite: p?.rewrite.status ?? 'off',
        ...(p?.rewrite.reason ? { rewrite_reason: p.rewrite.reason } : {}),
        cmd_in_bytes: p?.cmdIn ?? 0,
        cmd_out_bytes: p !== undefined && event.toolName === BASH_TOOL ? bytes(p.rewrite.command) : 0,
        admit: 'off', admit_reason: ADMIT_OFF_REASON, out_bytes_before: out, out_bytes_after: out,
        is_error: event.isError, ms_rewrite: p?.rewrite.ms ?? 0,
        ms_tool: p === undefined ? 0 : Math.max(0, ports.nowMs() - p.startMs - p.rewrite.ms),
        ms_admit: 0,
      }
      // A ledger write that never answers must not hold the result.
      await within(ports, LEDGER_BUDGET_MS, appendLedger(ports, cfg, row), () => undefined)
    } catch {
      // Ledger failures must not change the tool result.
    }
    return undefined
  })
}
