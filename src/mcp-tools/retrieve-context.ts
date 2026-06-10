/**
 * retrieve_context — THE canonical subagent entry point.
 *
 * One call, one audit event, three lists. Aggregates rules + skills + memories
 * for the agent's current intent.
 *
 * The handler delegates the WHOLE pipeline to ctx.orchestrator
 * (src/retrieval/index.ts): repo-root detection, the scope-aware
 * context_hash cache, the per-call CorpusReader with the correct repoRoot,
 * DomainRouter capping, the async RetrievalScorer seam, and the single
 * 'retrieve' audit event. The tool owns only its input schema and the
 * G5-M1 match shaping — it duplicates none of the orchestration logic
 * (previously it hand-rolled retrieval against the singleton global-only
 * CorpusReader and could never return repo-scope artifacts while still
 * reporting scopes_queried: ["global","repo"]).
 *
 * Description string MUST contain the literal phrase
 *   "ALWAYS call retrieve_context as your first action"
 * per DX-FIX-8 (multi-agent eng review §1.6 lever a).
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Rule,
  Skill,
  Memory,
} from '../app.js'
import type { RetrieveMatchInfo } from '../contracts/retrieval.js'

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
  top_k_per_kind: z.number().int().positive().max(32).optional().default(4),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

type Input = z.infer<typeof inputSchema>

interface RetrieveContextBase {
  rules: Rule[]
  skills: Skill[]
  memories: Memory[]
  overridden_global_ids: string[]
  repo_root_detected: string | null
  scopes_queried: Array<'global' | 'repo'>
}

/**
 * G5-M1: the output carries a first-class `match` discriminant
 * (RetrieveMatchInfo from src/contracts/retrieval.ts). A retrieval that
 * matches NOTHING returns `{ match: "none", reason: "no_match",
 * query_echo, scopes_queried, ...empty lists }` so agents branch on it
 * explicitly instead of inferring from bare empty arrays. The
 * orchestrator returns the v1.0 envelope; this tool layers the
 * discriminant on top.
 */
type RetrieveContextOutput = RetrieveContextBase & RetrieveMatchInfo

const DESCRIPTION =
  'ALWAYS call retrieve_context as your first action on any code task. ' +
  'Returns the rules, skills, and prior episodes (memories) relevant to your ' +
  'current intent — merged across the global corpus (~/.betterai/) and the ' +
  'current repo corpus (<repo-root>/.betterai/) if one is detected. Pass the ' +
  'file paths you intend to edit, your stated intent, and any symbols in scope. ' +
  'One call, one audit event, three lists. Cheaper than calling ' +
  'retrieve_rules/retrieve_skills/retrieve_memories separately.'

const tool: McpTool<unknown, RetrieveContextOutput> = {
  name: 'retrieve_context',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<RetrieveContextOutput> => {
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k_per_kind, scope } = input

    // The orchestrator owns repo detection, scope gating (scopes_queried
    // reflects only corpora that are actually readable), the cache, the
    // scoring, and emits exactly ONE 'retrieve' audit event per call —
    // hit or miss. No second event here.
    const out = await ctx.orchestrator.retrieveContext(
      { context, top_k_per_kind, scope },
      meta,
    )

    // G5-M1: zero artifacts across every kind is a first-class outcome,
    // not bare empty arrays. The orchestrator's audit event still fired
    // with rules_returned: [] so the no-match retrieval stays observable.
    const matchedAnything =
      out.rules.length + out.skills.length + out.memories.length > 0
    return matchedAnything
      ? { ...out, match: 'matched' as const }
      : {
          ...out,
          match: 'none' as const,
          reason: 'no_match' as const,
          query_echo: {
            intent: context.intent ?? '',
            file_paths: context.file_paths ?? [],
            symbols: context.symbols ?? [],
          },
        }
  },
}

export default tool
