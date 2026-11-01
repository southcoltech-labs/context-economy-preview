// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayConfig } from '../../plugins/tool-gateway/hooks/config'
import { createTrust } from '../../plugins/tool-gateway/hooks/rtk-trust'
import { trustedRewrite } from '../../plugins/tool-gateway/hooks/trusted-rewrite'
import { createPorts, realPathOf } from '../tool-gateway/io'
import { OUTPUT_MAX_BYTES, ProcessOutputLimit, ProcessTimeout, runBounded } from './process'

// The deadline must hold for a child that ignores SIGTERM, through the
// actual Node port the Pi gateway uses.

const dirs: string[] = []
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'ce-pi-proc-'))); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A shell child that ignores SIGTERM, sleeps, then writes `marker` and prints success. */
const stubborn = (marker: string, sleepS: number): string[] =>
  ['/bin/sh', '-c', `trap "" TERM; /bin/sleep ${sleepS}; : > '${marker}'; printf "rtk ls"`]

describe('runBounded', () => {
  test('returns output of a process that finishes in time', async () => {
    const r = await runBounded(['/bin/sh', '-c', 'printf ok; printf err >&2; exit 3'], { timeoutMs: 2000 })
    expect(r).toEqual({ exitCode: 3, stdout: 'ok', stderr: 'err' })
  })
  test('passes stdin', async () => {
    const r = await runBounded(['/bin/cat'], { stdin: 'hello', timeoutMs: 2000 })
    expect(r.stdout).toBe('hello')
  })
  test('a SIGTERM-resistant child: fails at the deadline, never returns late success, and is killed', async () => {
    const marker = join(tmp(), 'late')
    const started = Date.now()
    const outcome = await runBounded(stubborn(marker, 0.4), { timeoutMs: 20 }).then(r => r, e => e)
    const elapsed = Date.now() - started
    expect(outcome).toBeInstanceOf(ProcessTimeout)
    expect(elapsed).toBeLessThan(200)
    await sleep(700)
    expect(existsSync(marker)).toBe(false)
  })
  test('the deadline covers the whole process group (a grandchild holding the pipes)', async () => {
    const started = Date.now()
    const outcome = await runBounded(['/bin/sh', '-c', '/bin/sleep 5 & wait'], { timeoutMs: 50 }).then(r => r, e => e)
    expect(outcome).toBeInstanceOf(ProcessTimeout)
    expect(Date.now() - started).toBeLessThan(300)
  })
  test('a UTF-8 character split across chunks decodes whole, on stdout and stderr', async () => {
    // 中 is e4 b8 ad: the first byte arrives alone, the rest 30 ms later.
    const split = "printf '\\344'; /bin/sleep 0.03; printf '\\270\\255 file'"
    const r = await runBounded(['/bin/sh', '-c', `${split}; (${split}) >&2`], { timeoutMs: 2000 })
    expect(r.stdout).toBe('中 file')
    expect(r.stderr).toBe('中 file')
  })
  test('output past the byte bound kills the group and fails, on either stream', async () => {
    for (const stream of ['', '>&2']) {
      const started = Date.now()
      const outcome = await runBounded(['/bin/sh', '-c', `exec /usr/bin/yes x ${stream}`], { timeoutMs: 5000 }).then(r => r, e => e)
      expect(outcome).toBeInstanceOf(ProcessOutputLimit)
      expect(Date.now() - started).toBeLessThan(2000)
    }
  })
  test('large simultaneous stdout and stderr under the bound are returned whole', async () => {
    const n = Math.floor(OUTPUT_MAX_BYTES / 4)
    const r = await runBounded(['/bin/sh', '-c', `/usr/bin/head -c ${n} /dev/zero & /usr/bin/head -c ${n} /dev/zero >&2; wait`], { timeoutMs: 5000 })
    expect(r.stdout.length).toBe(n)
    expect(r.stderr.length).toBe(n)
  })
  test('a smaller bound can be asked for', async () => {
    await expect(runBounded(['/bin/sh', '-c', 'printf 12345'], { timeoutMs: 2000, maxBytes: 4 })).rejects.toBeInstanceOf(ProcessOutputLimit)
    expect((await runBounded(['/bin/sh', '-c', 'printf 1234'], { timeoutMs: 2000, maxBytes: 4 })).stdout).toBe('1234')
  })
  test('no time left: fails without starting anything', async () => {
    await expect(runBounded(['/bin/echo', 'x'], { timeoutMs: 0 })).rejects.toBeInstanceOf(ProcessTimeout)
  })
})

describe('the gateway port', () => {
  test("the reviewer's reproduction now fails at the deadline", async () => {
    const marker = join(tmp(), 'late')
    const started = Date.now()
    const outcome = await createPorts({ setStatus() {} }).run(stubborn(marker, 0.4), { timeoutMs: 20 }).then(r => r, e => e)
    expect(outcome).toBeInstanceOf(ProcessTimeout)
    expect(Date.now() - started).toBeLessThan(200)
  })

  /** A real executable standing in for RTK: owned by us, 0755, `--version` in range, `rewrite` stubborn. */
  const fakeRtk = (rewriteSleepS: number): string => {
    const dir = tmp()
    const bin = join(dir, 'rtk')
    writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "rtk 0.47.0"; exit 0; fi',
      `trap "" TERM; /bin/sleep ${rewriteSleepS}; printf "rtk ls"; exit 0`,
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    return bin
  }

  test('one 1 s budget across trust check, --version and a stubborn rewrite: original command, error, bounded', async () => {
    const bin = fakeRtk(3)
    const cfg = gatewayConfig({ home: tmp(), flag: undefined, host: 'pi' })
    const started = Date.now()
    const r = await trustedRewrite({
      ports: createPorts({ setStatus() {} }), cfg, trust: createTrust(),
      realPath: realPathOf, envBin: () => bin, readConfig: async () => undefined,
    }, 'ls')
    const elapsed = Date.now() - started
    expect(r.command).toBe('ls')
    expect(r.status).toBe('error')
    expect(elapsed).toBeLessThan(cfg.rewriteTimeoutMs + 300)
  })
  test('the same executable rewrites when it answers in time', async () => {
    const bin = fakeRtk(0)
    const cfg = gatewayConfig({ home: tmp(), flag: undefined, host: 'pi' })
    const r = await trustedRewrite({
      ports: createPorts({ setStatus() {} }), cfg, trust: createTrust(),
      realPath: realPathOf, envBin: () => bin, readConfig: async () => undefined,
    }, 'ls')
    expect(r.status).toBe('applied')
    expect(r.command).toBe(`'${bin}' ls`)
  })
})
