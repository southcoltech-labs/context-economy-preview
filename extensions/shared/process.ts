// SPDX-License-Identifier: Apache-2.0

/**
 * The Pi extensions' process port on Node, with a deadline that holds whatever the child does.
 * `spawn`'s own `timeout` only sends SIGTERM and still waits for `close`, so a child that ignores
 * SIGTERM could hold a hook past its budget and then return output as if in time. Here the child
 * runs in its own process group; at the deadline the whole group gets SIGKILL and the call fails
 * at once. Output that arrives later is never returned.
 *
 * Output is kept as bytes and decoded once at the end, so a UTF-8 character split across chunks
 * stays whole (a rewritten filename must not change). Each stream is bounded: past `maxBytes` the
 * group is killed and the call fails, so a faulty executable cannot fill the host's memory.
 */
import { spawn } from 'node:child_process'

export type RunInit = { stdin?: string; timeoutMs?: number; env?: Record<string, string>; maxBytes?: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** Per stream. RTK's rewrite and `--version`, and `stat`, `uname`, `id`, print far less. */
export const OUTPUT_MAX_BYTES = 1024 * 1024

export class ProcessTimeout extends Error {}
export class ProcessOutputLimit extends Error {}

/** argv[0] is an absolute path chosen by the caller's trust checks; no shell, no PATH lookup of our own. */
export const runBounded = (argv: readonly string[], init: RunInit = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv
    const limit = init.timeoutMs
    if (limit !== undefined && limit <= 0) {
      reject(new ProcessTimeout(`${String(cmd)}: no time left`))
      return
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      finish()
    }
    const child = spawn(cmd as string, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: init.env === undefined ? process.env : { ...process.env, ...init.env },
    })
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    if (limit !== undefined) timer = setTimeout(() => {
      killGroup()
      settle(() => reject(new ProcessTimeout(`${String(cmd)}: timed out after ${limit} ms`)))
    }, limit)
    const maxBytes = init.maxBytes ?? OUTPUT_MAX_BYTES
    const collect = (stream: NodeJS.ReadableStream, name: string): Buffer[] => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (d: Buffer) => {
        if (settled) return
        size += d.length
        if (size > maxBytes) {
          killGroup()
          settle(() => reject(new ProcessOutputLimit(`${String(cmd)}: ${name} over ${maxBytes} bytes`)))
          return
        }
        chunks.push(d)
      })
      return chunks
    }
    const stdout = collect(child.stdout, 'stdout')
    const stderr = collect(child.stderr, 'stderr')
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')
    child.on('error', e => settle(() => reject(e)))
    child.on('close', code => settle(() => resolve({ exitCode: code ?? -1, stdout: text(stdout), stderr: text(stderr) })))
    child.stdin.on('error', () => undefined)
    child.stdin.end(init.stdin ?? '')
  })
