// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { registerLoadoutTrim } from './loadout'

type Handler = () => void
const fakePi = (active: string[]) => {
  const handlers: Record<string, Handler> = {}
  const state = { active: [...active] }
  const pi = {
    on: (event: string, h: Handler) => { handlers[event] = h },
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => { state.active = [...names] },
  }
  return { pi, handlers, state }
}

describe('tool loadout trim', () => {
  test('on session_start, deactivates the listed tools and keeps the rest in order', () => {
    const f = fakePi(['read', 'bash', 'bg_task_spawn', 'bg_task', 'bg_task_log', 'bg_status'])
    registerLoadoutTrim(f.pi, ['bg_task', 'bg_status'])
    expect(f.state.active).toContain('bg_task')
    f.handlers.session_start!()
    expect(f.state.active).toEqual(['read', 'bash', 'bg_task_spawn', 'bg_task_log'])
  })
  test('no listed tool active: active set is not touched', () => {
    const f = fakePi(['read', 'bash'])
    let calls = 0
    f.pi.setActiveTools = () => { calls++ }
    registerLoadoutTrim(f.pi, ['bg_task'])
    f.handlers.session_start!()
    expect(calls).toBe(0)
  })
})
