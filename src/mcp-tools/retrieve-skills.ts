/**
 * retrieve_skills — single-kind retrieval for skills only.
 *
 * Skills are procedures ("HOW to do Y step-by-step"). Same scoping/merge
 * semantics as rules and memories.
 *
 * Delegates to ctx.orchestrator.retrieveSkills — the orchestrator owns repo
 * detection, the scope-aware cache, scoring, and emits the single 'retrieve'
 * audit event for the call. The tool keeps only its input schema and output
 * contract (a plain Skill[]).
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Skill,
} from '../server/main.js'

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
  'Return the skills (step-by-step procedures — "HOW to do Y") most relevant to ' +
  'the current code context. Prefer retrieve_context if you also want rules and ' +
  'memories in a single call.'

const tool: McpTool<unknown, Skill[]> = {
  name: 'retrieve_skills',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<Skill[]> => {
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k, scope } = input

    const { items } = await ctx.orchestrator.retrieveSkills(
      { context, top_k, scope },
      meta,
    )
    return items
  },
}

export default tool
