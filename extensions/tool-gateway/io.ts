// SPDX-License-Identifier: Apache-2.0

/** Ports on Node fs and the bounded process runner, for the shared gateway core. */
import { mkdirSync } from 'node:fs'
import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { CONFIG_FILE, LEDGER_DIRECTORY } from '../../plugins/tool-gateway/hooks/config'
import type { Ports } from '../../plugins/tool-gateway/hooks/types'
import { runBounded } from '../shared/process'
import { LEDGER_DIR_MODE, LEDGER_FILE_MODE, STATUS_KEY } from './config'

const run: Ports['run'] = (argv, init) => runBounded(argv, init)

const writeFileAtomic = async (path: string, text: string): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true, mode: LEDGER_DIR_MODE })
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, text, { mode: LEDGER_FILE_MODE })
  await rename(temp, path)
}

export type StatusSink = { setStatus(key: string, text: string | undefined): void }

export const createPorts = (ui: StatusSink): Ports => ({
  run,
  writeFile: writeFileAtomic,
  status: text => ui.setStatus(STATUS_KEY, text),
  nowMs: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal, ref: false }),
})

/** Where a path lands (Node realpath); undefined when it leads nowhere. */
export const realPathOf = async (path: string): Promise<string | undefined> =>
  realpath(path).catch(() => undefined)

/** Text of `~/.claude/context-economy/config.json`, shared with the Claude plugins; undefined when absent. */
export const readGatewayConfig = async (home: string = homedir()): Promise<string | undefined> =>
  readFile(join(home, LEDGER_DIRECTORY, CONFIG_FILE), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined
    throw e
  })
