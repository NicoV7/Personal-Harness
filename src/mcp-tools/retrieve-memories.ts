/**
 * retrieve_memories — single-kind retrieval for memories (prior episodes).
 *
 * Memories are episodes — decisions, failures, discoveries, constraints — that
 * happened in the past and that future-you should not relitigate. Same scoping
 * and merge semantics as rules.
 *
 * Delegates to ctx.orchestrator.retrieveMemories — the orchestrator owns repo
 * detection, the scope-aware cache, scoring, and emits the single 'retrieve'
 * audit event for the call. The tool keeps only its input schema and output
 * contract (a plain Memory[]).
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Memory,
} from '../app.js'

const contextSchema = z
  .object({
    file_paths: z.array(z.string()).optional(),
    intent: z.string().optional(),
    symbols: z.array(z.string()).optional(),
    recent_diff: z.string().optional(),
  })
  .strict()

const inputSchema = z.object({
  context: contextSchema,
  top_k: z.number().int().positive().max(64).optional().default(4),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

type Input = z.infer<typeof inputSchema>

const DESCRIPTION =
  'Return the memories (prior episodes — decisions, failures, discoveries, ' +
  'constraints) most relevant to the current code context. Includes ' +
  '"Don\'t relitigate" notes from long-durability decision-memories. Prefer ' +
  'retrieve_context if you also want rules and skills in a single call.'

const tool: McpTool<unknown, Memory[]> = {
  name: 'retrieve_memories',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<Memory[]> => {
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k, scope } = input

    const { items } = await ctx.orchestrator.retrieveMemories(
      { context, top_k, scope },
      meta,
    )
    return items
  },
}

export default tool
