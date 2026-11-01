// SPDX-License-Identifier: Apache-2.0

/**
 * Every active tool's schema is sent on every request. Some packages register wrapper tools
 * that duplicate their single-purpose tools (pi-better-background-tasks: `bg_task`, `bg_status`).
 * Pi's `defaultTools` cannot remove extension tools, so deactivate the listed ones at session start.
 * They stay registered; `setActiveTools` or `--tools` can still turn them on.
 */
type LoadoutPi = {
  on(event: 'session_start', handler: () => void): unknown
  getActiveTools(): string[]
  setActiveTools(names: string[]): void
}

export const registerLoadoutTrim = (pi: LoadoutPi, inactive: readonly string[]): void => {
  pi.on('session_start', () => {
    const active = pi.getActiveTools()
    const kept = active.filter(name => !inactive.includes(name))
    if (kept.length !== active.length) pi.setActiveTools(kept)
  })
}
