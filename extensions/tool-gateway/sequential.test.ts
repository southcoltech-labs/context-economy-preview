// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { registerSequentialMutations } from './sequential'

type Def = { name: string; executionMode?: string; execute: () => string }
const builtin = (name: string): Def => ({ name, execute: () => `ran ${name}` })

describe('sequential file-mutating tools', () => {
  test('re-registers edit and write as sequential, keeping the built-in behavior', () => {
    const registered: Def[] = []
    registerSequentialMutations({ registerTool: d => registered.push(d as Def) }, builtin)
    expect(registered.map(d => d.name)).toEqual(['edit', 'write'])
    for (const d of registered) {
      expect(d.executionMode).toBe('sequential')
      expect(d.execute()).toBe(`ran ${d.name}`)
    }
  })
  test('a missing built-in fails fast', () => {
    const none = (name: string) => { throw new Error(`no built-in ${name}`) }
    expect(() => registerSequentialMutations({ registerTool: () => {} }, none)).toThrow('no built-in edit')
  })
})
