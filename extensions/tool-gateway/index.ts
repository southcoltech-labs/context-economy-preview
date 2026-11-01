// SPDX-License-Identifier: Apache-2.0

/**
 * Pi extension entry: registration only. Load for dev with `pi -e <this dir>/index.ts`.
 * `CE_TOOL_GATEWAY=off` turns off everything here: the gateway handlers, the sequential
 * `edit`/`write` overrides and the loadout trim.
 */
import { homedir } from 'node:os'
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent'
import { gatewayConfig } from '../../plugins/tool-gateway/hooks/config'
import { RTK_BIN_ENV, createTrust } from '../../plugins/tool-gateway/hooks/rtk-trust'
import { createPorts, readGatewayConfig, realPathOf } from './io'
import { INACTIVE_TOOLS } from './config'
import { registerLoadoutTrim } from './loadout'
import { registerGateway } from './register'
import { registerSequentialMutations } from './sequential'

type Pi = Parameters<typeof registerGateway>[0]

export default function toolGateway(pi: Pi): void {
  const home = homedir()
  const cfg = gatewayConfig({ home, flag: process.env.CE_TOOL_GATEWAY, host: 'pi' })
  if (!cfg.enabled) return
  registerGateway(pi, {
    cfg,
    makePorts: ctx => createPorts((ctx as unknown as { ui: Parameters<typeof createPorts>[0] }).ui),
    trust: createTrust(),
    realPath: realPathOf,
    envBin: () => process.env[RTK_BIN_ENV],
    readConfig: () => readGatewayConfig(home),
  })
  const builtins: Record<string, (cwd: string) => object> = {
    edit: createEditToolDefinition, write: createWriteToolDefinition,
  }
  registerSequentialMutations(pi as unknown as Parameters<typeof registerSequentialMutations>[0], name => {
    const make = builtins[name]
    if (!make) throw new Error(`no built-in ${name}`)
    return make(process.cwd())
  })
  registerLoadoutTrim(pi as unknown as Parameters<typeof registerLoadoutTrim>[0], INACTIVE_TOOLS)
}
