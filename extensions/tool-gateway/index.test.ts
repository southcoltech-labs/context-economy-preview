// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, mock, test } from 'bun:test'

// I4: the off switch is checked at the real entrypoint, not only inside registerGateway. The Pi
// package is an optional peer and is not installed for tests; the entrypoint needs only its two
// built-in tool factories.
mock.module('@earendil-works/pi-coding-agent', () => ({
  createEditToolDefinition: () => ({ name: 'edit' }),
  createWriteToolDefinition: () => ({ name: 'write' }),
}))
const { default: toolGateway } = await import('./index')

const saved = process.env.CE_TOOL_GATEWAY
afterEach(() => {
  if (saved === undefined) delete process.env.CE_TOOL_GATEWAY
  else process.env.CE_TOOL_GATEWAY = saved
})

/** A Pi that records everything the extension registers. */
const fakePi = () => {
  const events: string[] = []
  const tools: string[] = []
  const pi = {
    on: (event: string) => { events.push(event) },
    registerTool: (d: { name: string }) => { tools.push(d.name) },
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  }
  return { pi, events, tools }
}

describe('the extension entrypoint', () => {
  test('CE_TOOL_GATEWAY=off registers nothing: no handlers, no tool overrides, no loadout trim', () => {
    process.env.CE_TOOL_GATEWAY = 'off'
    const f = fakePi()
    toolGateway(f.pi as never)
    expect(f.events).toEqual([])
    expect(f.tools).toEqual([])
  })
  test('on by default: the gateway handlers, sequential edit and write, and the loadout trim', () => {
    delete process.env.CE_TOOL_GATEWAY
    const f = fakePi()
    toolGateway(f.pi as never)
    expect(f.events.sort()).toEqual(['session_start', 'tool_call', 'tool_result'])
    expect(f.tools).toEqual(['edit', 'write'])
  })
})
