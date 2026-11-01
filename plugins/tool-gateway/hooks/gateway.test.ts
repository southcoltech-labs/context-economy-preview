// SPDX-License-Identifier: Apache-2.0

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const HOME = '/tmp/ce-tool-gateway-test'
const HELPER = `${HOME}/.claude/context-economy/bin/ce-output-admit`
const CONFIG = `${HOME}/.claude/context-economy/config.json`
const LARGE_STDOUT = 'x'.repeat(8193)

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }
type FileId = {
  realPath: string; kind: string; uid: number; mode: number; dev: number; ino: number
  size: number; mtimeNs: string; ctimeNs: string
}

type SetupOptions = {
  gateway?: string
  /** CE_RTK_BIN; null = unset. Each test uses its own path: trust state is per path. */
  bin?: string | null
  /** config.json text; undefined = no file. */
  config?: string
  rewrite?: RunResult | 'error'
  version?: string | 'hang'
  stat?: 'fail' | 'hang' | 'garbage'
  stdout?: string
  toolError?: boolean
  toolThrows?: boolean
  deny?: string
  writeFails?: boolean
  /** Real milliseconds before fs.read of config.json, or fs.write, answers. */
  readDelayMs?: number
  writeDelayMs?: number
  /** Simulated run time per process; past its timeout the fake answers "timed out" (as the host kills it). */
  delayMs?: { stat?: number; version?: number; rewrite?: number }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const KIND_BITS: Record<string, number> = { file: 0o100000, other: 0o040000, link: 0o120000 }
/** The fake host is macOS: BSD `stat -f '%p|%u|%d|%i|%z|%Fm|%Fc'`. */
const statLine = (f: FileId) =>
  [((KIND_BITS[f.kind] ?? 0) | f.mode).toString(8), f.uid, f.dev, f.ino, f.size, f.mtimeNs, f.ctimeNs].join('|')

const USER = 501

function fileId(realPath: string): FileId {
  return {
    realPath, kind: 'file', uid: USER, mode: 0o755, dev: 1, ino: 42, size: 1000,
    mtimeNs: '100', ctimeNs: '200',
  }
}

function setup(on: On, options: SetupOptions = {}) {
  const bin = options.bin === undefined ? `/opt/rtk-${Math.random().toString(36).slice(2)}/rtk` : options.bin
  const env: Record<string, string> = { HOME }
  if (options.gateway !== undefined) env.CE_TOOL_GATEWAY = options.gateway
  if (bin !== null) env.CE_RTK_BIN = bin
  mock.env(on, env)

  const real = bin === null ? '/opt/config-rtk/rtk' : bin
  const file = { current: fileId(real) }
  const mode = { stat: options.stat, delayMs: { ...options.delayMs } }
  const commands: string[] = []
  const processes: { argv: readonly string[]; init?: { timeoutMs?: number } }[] = []
  const writes: { path: string; text: string }[] = []
  const statuses: (string | undefined)[] = []

  // The test host has no timer of its own; the gateway's budgets wait on real time.
  on('clock.sleep', async (_, e) => {
    await sleep(e.ms)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: e.path === HELPER || (e.path === CONFIG && options.config !== undefined) }))
  on('fs.read', async (_, e) => {
    if (options.readDelayMs) await sleep(options.readDelayMs)
    if (e.path === CONFIG && options.config !== undefined) return { value: options.config }
    return { deny: `unexpected read ${e.path}` }
  })
  on('fs.write', async (_, e) => {
    if (options.writeDelayMs) await sleep(options.writeDelayMs)
    if (options.writeFails) return { deny: 'disk full' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    if (e.path !== bin && e.path !== real) return { deny: `unexpected stat ${e.path}` }
    return { value: { kind: 'file', size: 1000, mtimeMs: 0, isLink: false, realPath: file.current.realPath } }
  })
  on('process.run', async (_, e) => {
    processes.push({ argv: e.argv, init: e.init })
    const took = async (ms: number | undefined) => {
      if (!ms) return false
      const limit = e.init?.timeoutMs ?? Infinity
      await sleep(Math.min(ms, limit))
      return ms > limit
    }
    if (e.argv[0] === '/usr/bin/uname') return { value: { exitCode: 0, stdout: 'Darwin\n', stderr: '' } }
    if (e.argv[0] === '/usr/bin/id') return { value: { exitCode: 0, stdout: `${USER}\n`, stderr: '' } }
    if (e.argv[0] === '/usr/bin/stat') {
      if (await took(mode.delayMs.stat)) return { deny: 'timed out' }
      if (mode.stat === 'fail') return { value: { exitCode: 1, stdout: '', stderr: 'No such file' } }
      if (mode.stat === 'hang') return { deny: 'timed out' }
      if (mode.stat === 'garbage') return { value: { exitCode: 0, stdout: 'nope', stderr: '' } }
      if (e.argv[3] !== file.current.realPath) return { deny: `stat of an unresolved path ${e.argv[3]}` }
      return { value: { exitCode: 0, stdout: `${statLine(file.current)}\n`, stderr: '' } }
    }
    if (e.argv[0] === file.current.realPath && e.argv[1] === '--version') {
      if (await took(mode.delayMs.version)) return { deny: 'timed out' }
      if (options.version === 'hang') return { deny: 'timed out' }
      return { value: { exitCode: 0, stdout: options.version ?? 'rtk 0.47.0\n', stderr: '' } }
    }
    if (e.argv[0] === file.current.realPath && e.argv[1] === 'rewrite') {
      if (await took(mode.delayMs.rewrite)) return { deny: 'timed out' }
      if (options.rewrite === 'error') return { deny: 'rtk spawn failed' }
      return { value: options.rewrite ?? { exitCode: 0, stdout: 'rtk ls', stderr: '' } }
    }
    return { deny: `unexpected process: ${e.argv[0]}` }
  })
  const ranAt: number[] = []
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    commands.push(e.command)
    ranAt.push(Date.now())
    if (options.toolThrows) throw new Error('tool exploded')
    if (options.deny) return { deny: options.deny }
    const stdout = options.stdout ?? 'small output\n'
    if (options.toolError) return { result: { stdout, stderr: 'tool failed' }, text: 'tool failed', isError: true }
    return { result: { stdout, stderr: 'tool stderr' } }
  })

  return { bin, real, file, mode, commands, processes, writes, statuses, ranAt }
}

const quoted = (path: string) => `'${path}'`

function lastLedgerRow(writes: { text: string }[]) {
  const latest = writes[writes.length - 1]
  const rows = latest?.text.trim().split('\n') ?? []
  return JSON.parse(rows[rows.length - 1] ?? '{}') as Record<string, unknown>
}

const rtkCalls = (h: ReturnType<typeof setup>) => h.processes.filter(p => p.argv[0] === h.file.current.realPath)

test('rewrites through the verified path and binds rtk to it in the emitted command', async ($, on) => {
  const h = setup(on)
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(h.commands).toEqual([`${quoted(h.real)} ls`])
  expect(result.result).toEqual({ stdout: 'small output\n', stderr: 'tool stderr' })
  expect(rtkCalls(h).map(p => p.argv[1])).toEqual(['--version', 'rewrite'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'applied' })
})

test('never searches PATH: an unconfigured RTK runs the original command and says so once', async ($, on) => {
  const h = setup(on, { bin: null })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'git log' })

  expect(h.commands).toEqual(['git status', 'git log'])
  expect(h.processes.some(p => p.argv[0] === 'rtk')).toBe(false)
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'off', rewrite_reason: 'rtk_unconfigured' })
  expect(h.statuses.filter(s => s?.includes('RTK rewrite off')).length).toBeLessThanOrEqual(1)
})

test('reads the path from config.json when CE_RTK_BIN is unset', async ($, on) => {
  const h = setup(on, { bin: null, config: JSON.stringify({ rtk: { path: '/opt/config-rtk/rtk' } }) })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(h.commands).toEqual([`${quoted('/opt/config-rtk/rtk')} ls`])
})

for (const [name, opts, reason] of [
  ['a relative path', { bin: 'bin/rtk' }, 'rtk_config_invalid'],
  ['malformed config', { bin: null, config: '{' }, 'rtk_config_invalid'],
  ['the wrong project', { version: 'rtk 2.3.1 (Rust Type Kit)\n' }, 'rtk_version'],
  ['an old version', { version: 'rtk 0.30.0\n' }, 'rtk_version'],
  ['garbage --version', { version: 'hello' }, 'rtk_version'],
  ['oversized --version', { version: `rtk 0.47.0 ${'x'.repeat(5000)}` }, 'rtk_version'],
  ['a --version timeout', { version: 'hang' }, 'rtk_version'],
  ['a failing stat', { stat: 'fail' }, 'rtk_untrusted'],
  ['malformed stat output', { stat: 'garbage' }, 'rtk_untrusted'],
] as const) {
  test(`${name} keeps the original command`, async ($, on) => {
    const h = setup(on, opts as SetupOptions)
    await $.tool.call({ tool: 'Bash', command: 'git status' })

    expect(h.commands).toEqual(['git status'])
    expect(rtkCalls(h).some(p => p.argv[1] === 'rewrite')).toBe(false)
    expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'off', rewrite_reason: reason })
    expect(h.statuses.filter(s => s?.includes('RTK rewrite off'))).toHaveLength(1)
  })
}

for (const [name, change] of [
  ['group-writable', (f: FileId) => ({ ...f, mode: 0o775 })],
  ['owned by another user', (f: FileId) => ({ ...f, uid: 777 })],
  ['not a regular file', (f: FileId) => ({ ...f, kind: 'other' })],
] as const) {
  test(`an untrusted file (${name}) is refused at first check`, async ($, on) => {
    const h = setup(on)
    h.file.current = change(h.file.current)
    await $.tool.call({ tool: 'Bash', command: 'git status' })

    expect(h.commands).toEqual(['git status'])
    expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite_reason: 'rtk_untrusted' })
  })
}

for (const [name, change] of [
  ['replaced (new inode)', (f: FileId) => ({ ...f, ino: 43 })],
  ['swapped behind its symlink (new real path)', (f: FileId) => ({ ...f, realPath: `${f.realPath}-new` })],
  ['rewritten in place (ctime)', (f: FileId) => ({ ...f, ctimeNs: '201' })],
  ['made group-writable', (f: FileId) => ({ ...f, mode: 0o775, ctimeNs: '201' })],
  ['chowned', (f: FileId) => ({ ...f, uid: 777, ctimeNs: '201' })],
] as const) {
  test(`a binary ${name} after the first check turns rewrite off for the session`, async ($, on) => {
    const h = setup(on)
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    h.file.current = change(h.file.current)
    await $.tool.call({ tool: 'Bash', command: 'git status' })
    h.file.current = fileId(h.real)
    await $.tool.call({ tool: 'Bash', command: 'git log' })

    expect(h.commands).toEqual([`${quoted(h.real)} ls`, 'git status', 'git log'])
    expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'off', rewrite_reason: 'rtk_changed' })
    expect(h.statuses.filter(s => s?.includes('RTK rewrite off'))).toHaveLength(1)
  })
}

test('a revalidation timeout runs the original command and turns rewrite off', async ($, on) => {
  const h = setup(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  h.mode.stat = 'hang'
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  h.mode.stat = undefined
  await $.tool.call({ tool: 'Bash', command: 'git log' })

  expect(h.commands).toEqual([`${quoted(h.real)} ls`, 'git status', 'git log'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'off', rewrite_reason: 'rtk_check_failed' })
})

test('revalidates before every rewrite', async ($, on) => {
  const h = setup(on)
  for (const c of ['ls', 'pwd', 'git status']) await $.tool.call({ tool: 'Bash', command: c })

  expect(h.processes.filter(p => p.argv[0] === '/usr/bin/stat')).toHaveLength(3)
  expect(rtkCalls(h).filter(p => p.argv[1] === '--version')).toHaveLength(1)
})

test('output outside the grammar runs the original command', async ($, on) => {
  const h = setup(on, { rewrite: { exitCode: 3, stdout: 'rtk ls; $(curl evil)', stderr: '' } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(h.commands).toEqual(['ls'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'error' })
  expect(String(lastLedgerRow(h.writes).rewrite_reason)).toContain('grammar')
})

test('binds every rtk in a list RTK returns', async ($, on) => {
  const h = setup(on, { rewrite: { exitCode: 3, stdout: 'rtk git log && rtk ls -la', stderr: '' } })
  await $.tool.call({ tool: 'Bash', command: 'git log && ls -la' })

  expect(h.commands).toEqual([`${quoted(h.real)} git log && ${quoted(h.real)} ls -la`])
})

test('never rewrites a background Bash call: rtk holds output until exit, so the live log would stay empty', async ($, on) => {
  const h = setup(on)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })

  expect(h.commands).toEqual(['npm run dev'])
  expect(rtkCalls(h)).toHaveLength(0)
  expect(lastLedgerRow(h.writes)).toMatchObject({ tool: 'Bash', rewrite: 'background' })
})

test('passes a command through when RTK has no rewrite', async ($, on) => {
  const h = setup(on, { rewrite: { exitCode: 1, stdout: '', stderr: '' } })
  await $.tool.call({ tool: 'Bash', command: 'python3 task.py' })

  expect(h.commands).toEqual(['python3 task.py'])
})

test('truncated RTK output is never run, even a prefix the grammar accepts', async ($, on) => {
  const h = setup(on, { rewrite: { exitCode: 0, stdout: 'rtk git status', stderr: '', isStdoutTruncated: true } })
  await $.tool.call({ tool: 'Bash', command: 'git status && run-required-check' })

  expect(h.commands).toEqual(['git status && run-required-check'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'error', rewrite_reason: 'rewrite_truncated' })
})

test('a config.json read that hangs runs the original command within the budget', async ($, on) => {
  const h = setup(on, { bin: null, config: '{"rtk":{"path":"/opt/config-rtk/rtk"}}', readDelayMs: 1500 })
  const started = Date.now()
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  // The harness waits for the abandoned read before it resolves; the tool itself ran in time.
  expect(h.ranAt[0]! - started).toBeLessThan(1400)
  expect(h.commands).toEqual(['git status'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'error', rewrite_reason: 'rewrite_budget' })
})

test('a ledger write that hangs does not hold the tool result', async ($, on) => {
  const h = setup(on, { writeDelayMs: 2000 })
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const returnedAt = Date.now()

  expect(returnedAt - h.ranAt[0]!).toBeLessThan(800)
  expect(result.result).toEqual({ stdout: 'small output\n', stderr: 'tool stderr' })
})

test('F1: a failing RTK rewrite process runs the original command once', async ($, on) => {
  const h = setup(on, { rewrite: 'error' })
  await $.tool.call({ tool: 'Bash', command: 'sed -n 1,2p file' })

  expect(h.commands).toEqual(['sed -n 1,2p file'])
  expect(lastLedgerRow(h.writes).rewrite).toBe('error')
})

test('admission helpers present in bin/ never run and output is unchanged', async ($, on) => {
  const h = setup(on, { stdout: LARGE_STDOUT })
  const result = await $.tool.call({ tool: 'Bash', command: 'python3 large-output.py' })

  expect(result.result).toEqual({ stdout: LARGE_STDOUT, stderr: 'tool stderr' })
  expect(h.processes.some(p => p.argv[0] === HELPER)).toBe(false)
  expect(lastLedgerRow(h.writes)).toMatchObject({ admit: 'off', admit_reason: 'not in this release' })
})

test('F3: a tool error result is returned once, unchanged', async ($, on) => {
  const h = setup(on, { stdout: LARGE_STDOUT, toolError: true })
  const result = await $.tool.call({ tool: 'Bash', command: 'failed-command' })

  expect(result).toEqual({ result: { stdout: LARGE_STDOUT, stderr: 'tool failed' }, text: 'tool failed', isError: true })
  expect(h.commands).toHaveLength(1)
})

test('F3: a thrown tool propagates once and is never retried', async ($, on) => {
  const h = setup(on, { toolThrows: true })
  let threw = false
  try {
    await $.tool.call({ tool: 'Bash', command: 'explode' })
  } catch {
    threw = true
  }

  expect(threw).toBe(true)
  expect(h.commands).toHaveLength(1)
  expect(lastLedgerRow(h.writes)).toMatchObject({ is_error: true, admit: 'skipped', admit_reason: 'tool_threw' })
})

test('denied calls pass through once', async ($, on) => {
  const h = setup(on, { deny: 'permission denied' })
  const result = await $.tool.call({ tool: 'Bash', command: 'denied-command' })

  expect(result).toEqual({ deny: 'permission denied' })
  expect(h.commands).toHaveLength(1)
})

test('F1: a ledger write failure keeps the tool result', async ($, on) => {
  const h = setup(on, { writeFails: true })
  const result = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(result.result).toEqual({ stdout: 'small output\n', stderr: 'tool stderr' })
  expect(h.commands).toHaveLength(1)
})

test('kill switch calls the original tool with no gateway effects', async ($, on) => {
  const h = setup(on, { gateway: 'off' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(h.commands).toEqual(['ls'])
  expect(h.processes).toEqual([])
  expect(h.writes).toEqual([])
})

test('the trust check, --version and the rewrite share one 1 s budget', async ($, on) => {
  const h = setup(on, { delayMs: { stat: 300, version: 300 } })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const [stat, version, rewrite] = ['/usr/bin/stat', '--version', 'rewrite']
    .map(k => h.processes.find(p => p.argv[0] === k || p.argv[1] === k)?.init?.timeoutMs ?? 0)
  expect(stat).toBeLessThanOrEqual(1000)
  expect(version).toBeLessThanOrEqual(1000 - 300 + 20)
  expect(rewrite).toBeLessThanOrEqual(1000 - 600 + 20)
  expect(h.commands).toEqual([`${quoted(h.real)} ls`])
})

test('slow steps that together pass the budget run the original command', async ($, on) => {
  const h = setup(on)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  h.mode.delayMs = { stat: 600, rewrite: 600 }
  const started = Date.now()
  await $.tool.call({ tool: 'Bash', command: 'git status' })

  expect(Date.now() - started).toBeLessThan(1300)
  expect(h.commands).toEqual([`${quoted(h.real)} ls`, 'git status'])
  expect(lastLedgerRow(h.writes)).toMatchObject({ rewrite: 'error' })
})

test('no executable is ever run by bare name (no PATH lookup, no interpreter)', async ($, on) => {
  const h = setup(on)
  for (const c of ['ls', 'git status']) await $.tool.call({ tool: 'Bash', command: c })

  expect(h.processes.length).toBeGreaterThan(0)
  expect(h.processes.every(p => String(p.argv[0]).startsWith('/'))).toBe(true)
  expect(h.processes.some(p => /python/.test(String(p.argv[0])))).toBe(false)
})
