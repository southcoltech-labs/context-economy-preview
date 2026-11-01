// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { gatewayConfig } from '../../plugins/tool-gateway/hooks/config'
import { createTrust } from '../../plugins/tool-gateway/hooks/rtk-trust'
import { shellQuote } from '../../plugins/tool-gateway/hooks/shell-grammar'
import type { Ports } from '../../plugins/tool-gateway/hooks/types'
import { registerGateway } from './register'

type RunResult = Awaited<ReturnType<Ports['run']>>
type Handler = (event: any, ctx: any) => unknown
const BIG = 'x'.repeat(9000)
const USER = 501
const REAL = '/opt/rtk/0.47.0/bin/rtk'

type Opts = {
  flag?: string
  /** CE_RTK_BIN; null = unset. */
  bin?: string | null
  /** config.json text; undefined = no file. */
  config?: string
  rewrite?: RunResult
  version?: string
  mode?: number
  uid?: number
  id?: string
  /** Real milliseconds before a ledger write answers. */
  writeDelayMs?: number
}
let seq = 0
/** A fake macOS host: the system trust tools, a configured RTK at REAL, Pi's handlers. */
const setup = (o: Opts = {}) => {
  const handlers: Record<string, Handler> = {}
  const files: Record<string, string> = {}
  const runs: string[][] = []
  const statuses: (string | undefined)[] = []
  const bin = o.bin === undefined ? '/usr/local/bin/rtk' : o.bin
  const out = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '' })
  const ports: Ports = {
    run: async argv => {
      runs.push([...argv])
      if (argv[0] === '/usr/bin/uname') return out('Darwin\n')
      if (argv[0] === '/usr/bin/id') return out(`${USER}\n`)
      if (argv[0] === '/usr/bin/stat') {
        if (argv[3] !== REAL) return out('', 1)
        return out(`${(0o100000 | (o.mode ?? 0o755)).toString(8)}|${o.uid ?? USER}|1|42|1000|100|200\n`)
      }
      if (argv[0] === REAL && argv[1] === '--version') return out(o.version ?? 'rtk 0.47.0\n')
      if (argv[0] === REAL && argv[1] === 'rewrite') return o.rewrite ?? out('', 1)
      throw new Error(`unexpected process ${argv[0]}`)
    },
    writeFile: async (p, t) => {
      if (o.writeDelayMs) await new Promise(r => setTimeout(r, o.writeDelayMs))
      files[p] = t
    },
    status: text => { statuses.push(text) },
    nowMs: () => Date.now(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  }
  const home = `/tmp/pi-gw-test-${process.pid}-${seq++}`
  const cfg = gatewayConfig({ home, flag: o.flag, host: 'pi' })
  registerGateway({ on: (e: string, h: Handler) => { handlers[e] = h } } as never, {
    cfg,
    makePorts: () => ports,
    trust: createTrust(),
    realPath: async path => (path === bin || path === REAL ? REAL : undefined),
    envBin: () => bin ?? undefined,
    readConfig: async () => o.config,
  })
  const ctx = { sessionManager: { getSessionId: () => o.id ?? 'sess-1' } }
  const rows = () => Object.values(files).flatMap(t => t.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
  const call = (command: string, id = 'c1') => {
    const event = { type: 'tool_call', toolCallId: id, toolName: 'bash', input: { command } }
    return { event, done: Promise.resolve(handlers.tool_call!(event, ctx)) }
  }
  const result = (text: string, o2: { isError?: boolean; id?: string; toolName?: string; content?: unknown[] } = {}) =>
    Promise.resolve(handlers.tool_result!({
      type: 'tool_result', toolCallId: o2.id ?? 'c1', toolName: o2.toolName ?? 'bash', input: {},
      content: o2.content ?? [{ type: 'text', text }], isError: o2.isError ?? false, details: undefined,
    }, ctx))
  const rtkRuns = () => runs.filter(r => r[0] === REAL || r[0] === 'rtk')
  return { call, result, rows, runs, rtkRuns, files, cfg, handlers, ctx, statuses }
}

describe('rewrite only through the verified RTK', () => {
  test('a trusted RTK rewrites, and every rtk word becomes its quoted real path', async () => {
    const s = setup({ rewrite: { exitCode: 3, stdout: 'rtk git log && rtk ls -la\n', stderr: '' } })
    const { event, done } = s.call('git log && ls -la')
    expect(await done).toBeUndefined()
    expect(event.input.command).toBe(`${shellQuote(REAL)} git log && ${shellQuote(REAL)} ls -la`)
    expect(s.runs.map(r => r[0])).toContain('/usr/bin/stat')
    expect(s.rtkRuns().map(r => r[1])).toEqual(['--version', 'rewrite'])
  })
  test('unconfigured: no PATH lookup, no rtk run, rewrite off', async () => {
    const s = setup({ bin: null })
    const { event, done } = s.call('git status')
    await done
    await s.result('ok')
    expect(event.input.command).toBe('git status')
    expect(s.rtkRuns()).toEqual([])
    expect(s.rows()[0]).toMatchObject({ rewrite: 'off', rewrite_reason: 'rtk_unconfigured' })
  })
  test('config rtk.path is used when CE_RTK_BIN is unset', async () => {
    const s = setup({ bin: null, config: JSON.stringify({ rtk: { path: REAL } }), rewrite: { exitCode: 0, stdout: 'rtk ls', stderr: '' } })
    const { event, done } = s.call('ls')
    await done
    expect(event.input.command).toBe(`${shellQuote(REAL)} ls`)
  })
  test('a relative CE_RTK_BIN is refused, never looked up', async () => {
    const s = setup({ bin: 'rtk' })
    const { event, done } = s.call('ls')
    await done
    await s.result('ok')
    expect(event.input.command).toBe('ls')
    expect(s.rtkRuns()).toEqual([])
    expect(s.rows()[0].rewrite).toBe('off')
  })
  for (const [label, o, reason] of [
    ['group-writable', { mode: 0o775 }, 'rtk_untrusted'],
    ['owned by another user', { uid: 777 }, 'rtk_untrusted'],
    ['RTK 1.x (above the supported range)', { version: 'rtk 1.1.0\n' }, 'rtk_version'],
  ] as const) {
    test(`${label}: rewrite off, original command, one status line`, async () => {
      const s = setup(o)
      for (const id of ['a', 'b']) {
        const { event, done } = s.call('ls', id)
        await done
        expect(event.input.command).toBe('ls')
        await s.result('ok', { id })
      }
      expect(s.rtkRuns().filter(r => r[1] === 'rewrite')).toEqual([])
      expect(s.rows().map(r => r.rewrite_reason)).toEqual([reason, reason])
      expect(s.statuses.filter(t => String(t).includes(reason))).toHaveLength(1)
    })
  }
  test('output outside the grammar runs the original command', async () => {
    const s = setup({ rewrite: { exitCode: 3, stdout: 'rtk ls; $(curl evil)', stderr: '' } })
    const { event, done } = s.call('ls')
    await done
    await s.result('ok')
    expect(event.input.command).toBe('ls')
    expect(s.rows()[0].rewrite).toBe('error')
    expect(String(s.rows()[0].rewrite_reason)).toContain('grammar')
  })
  test('an rtk failure never blocks the call', async () => {
    const s = setup({ rewrite: { exitCode: 2, stdout: '', stderr: 'boom' } })
    const { event, done } = s.call('ls')
    expect(await done).toBeUndefined()
    expect(event.input.command).toBe('ls')
    await s.result('ok')
    expect(s.rows()[0].rewrite).toBe('error')
  })
  test('kill switch: no process, no change, no ledger', async () => {
    const s = setup({ flag: 'off', rewrite: { exitCode: 0, stdout: 'rtk ls', stderr: '' } })
    const { event, done } = s.call('ls')
    await done
    expect(await s.result(BIG)).toBeUndefined()
    expect(event.input.command).toBe('ls')
    expect(s.runs.length).toBe(0)
    expect(s.rows().length).toBe(0)
  })
  test('background spawn is never rewritten: rtk buffers output until exit', async () => {
    const s = setup({ rewrite: { exitCode: 3, stdout: 'rtk npm run dev', stderr: '' } })
    const event = { type: 'tool_call', toolCallId: 's1', toolName: 'bg_task_spawn', input: { command: 'npm run dev' } }
    await s.handlers.tool_call!(event, s.ctx)
    expect(event.input.command).toBe('npm run dev')
    expect(s.runs.length).toBe(0)
  })
  test('nested codemode bash call (parentToolCallId) is rewritten like a direct call', async () => {
    const s = setup({ rewrite: { exitCode: 0, stdout: 'rtk git status', stderr: '' } })
    const event = { type: 'tool_call', toolCallId: 'cm/1', parentToolCallId: 'cm', toolName: 'bash', input: { command: 'git status' } }
    await s.handlers.tool_call!(event, s.ctx)
    expect(event.input.command).toBe(`${shellQuote(REAL)} git status`)
  })
})

describe('no output admission', () => {
  for (const toolName of ['bash', 'codemode', 'bg_task_log']) {
    test(`${toolName}: large output is never replaced and no helper runs`, async () => {
      const s = setup({ bin: null })
      if (toolName === 'bash') await s.call('cat big').done
      expect(await s.result(BIG, { toolName })).toBeUndefined()
      expect(s.runs.filter(r => String(r[0]).includes('admit') || String(r[0]).includes('policy'))).toEqual([])
      expect(s.rows()[0]).toMatchObject({
        tool: toolName, admit: 'off', admit_reason: 'not in this release',
        out_bytes_before: 9000, out_bytes_after: 9000, ms_admit: 0,
      })
    })
  }
})

describe('ledger', () => {
  test('writes one metadata-only row per tool call, including non-bash tools, parallel-safe', async () => {
    const s = setup({ rewrite: { exitCode: 0, stdout: 'rtk ls', stderr: '' } })
    await s.call('ls', 'a').done
    await s.call('pwd', 'b').done
    await s.result('one', { id: 'b' })
    await s.result('two', { id: 'a' })
    await s.result('file text', { id: 'z', toolName: 'read' })
    const rows = s.rows()
    expect(rows.map(r => r.tool_use_id)).toEqual(['b', 'a', 'z'])
    expect(rows.map(r => r.tool)).toEqual(['bash', 'bash', 'read'])
    expect(rows[0].cmd_in_bytes).toBe(3)
    expect(rows[2].admit).toBe('off')
    const text = JSON.stringify(rows)
    for (const secret of ['file text', 'one', 'two', 'pwd']) expect(text).not.toContain(secret)
  })
  test('error results are recorded as errors', async () => {
    const s = setup({ bin: null })
    await s.call('false').done
    expect(await s.result('boom', { isError: true })).toBeUndefined()
    expect(s.rows()[0]).toMatchObject({ is_error: true, admit: 'off' })
  })
  test('ledger lands in the Pi ledger directory', async () => {
    const s = setup()
    await s.call('ls').done
    await s.result('ok')
    expect(Object.keys(s.files)[0]).toStartWith(s.cfg.ledgerPath)
    expect(s.cfg.ledgerPath).toEndWith('/gateway-ledger-pi')
  })
})

describe('a slow filesystem', () => {
  test('a ledger write that hangs does not hold the tool result', async () => {
    const s = setup({ writeDelayMs: 2000 })
    await s.call('ls').done
    const started = Date.now()
    expect(await s.result('ok')).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(800)
  })
})
