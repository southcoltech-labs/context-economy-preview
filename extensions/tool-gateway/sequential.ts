// SPDX-License-Identifier: Apache-2.0

/**
 * Pi runs tool calls from one message in parallel. A `bash` check sent with an `edit`
 * could run before the edit lands. Re-register the built-in file tools as sequential:
 * Pi then runs the whole batch in order (agent-loop executeToolCalls), so the model can
 * send "edit + test" in one message and save a turn, as Claude Code already allows.
 */
import { FILE_MUTATING_TOOLS, SEQUENTIAL_MODE } from './config'

type ToolRegistrar = { registerTool(definition: object): void }

export const registerSequentialMutations = (
  pi: ToolRegistrar,
  builtinDefinition: (name: string) => object,
): void => {
  for (const name of FILE_MUTATING_TOOLS) {
    pi.registerTool({ ...builtinDefinition(name), executionMode: SEQUENTIAL_MODE })
  }
}
