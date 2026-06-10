/**
 * retrieve_rules — single-kind retrieval for rules only.
 *
 * Prefer retrieve_context for any multi-kind retrieval. This tool exists for
 * VSCode commands and fine-grained agent retrieval when only rules are wanted.
 *
 * Delegates to ctx.orchestrator.retrieveRules — the orchestrator owns repo
 * detection, the scope-aware cache, scoring, and emits the single 'retrieve'
 * audit event for the call. The tool keeps only its input schema and output
 * contract (a plain Rule[]).
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Rule,
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
  top_k: z.number().int().positive().max(64).optional().default(8),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

type Input = z.infer<typeof inputSchema>

const DESCRIPTION =
  'Return the rules (constraints — "DON\'T do X, prefer Y") most relevant to the ' +
  'current code context. Prefer retrieve_context if you also want skills and ' +
  'memories in a single call.'

const tool: McpTool<unknown, Rule[]> = {
  name: 'retrieve_rules',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<Rule[]> => {
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k, scope } = input

    const { items } = await ctx.orchestrator.retrieveRules(
      { context, top_k, scope },
      meta,
    )
    return items
  },
}

export default tool
