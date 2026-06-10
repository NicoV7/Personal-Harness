/**
 * retrieve_context — THE canonical subagent entry point.
 *
 * One call, one audit event, three lists. Aggregates rules + skills + memories
 * for the agent's current intent. Implements the v4.1 scoping algorithm:
 *
 *   1. Detect repo root from context.file_paths (via detectRepoRoot).
 *   2. Check context_hash cache (keyed by scope + repo_root_detected per the
 *      `.betterai/STANDARDS/observability/context-hash-includes-scope` rule).
 *   3. On miss: ask corpusReader for global + repo candidates of each kind,
 *      merge with id-collision override (repo wins, global is dropped),
 *      rank by severity * match-strength * recency, truncate to top_k_per_kind.
 *   4. Emit exactly ONE 'retrieve' audit event (NOT three).
 *   5. Return the shaped result with `scope` tags on every item and the
 *      list of overridden global ids for diagnostics.
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
  AuditEvent,
} from '../server/main.js'
import { detectRepoRoot } from '../server/scope/detect.js'
import type { CachedRetrieval } from '../server/cache/context-hash.js'
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
 * explicitly instead of inferring from bare empty arrays.
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
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k_per_kind, scope } = input

    // 1. Detect repo root from the first file path. Falls back to null if no
    //    path was passed or the path is not inside a git repo with .betterai/.
    const repoRootDetected =
      context.file_paths && context.file_paths.length > 0
        ? detectRepoRoot(context.file_paths)
        : null

    // Which corpora we actually query depends on `scope` and whether a repo
    // root was detected.
    const scopesQueried: Array<'global' | 'repo'> = []
    if (scope === 'global') {
      scopesQueried.push('global')
    } else if (scope === 'repo') {
      if (repoRootDetected) scopesQueried.push('repo')
      else scopesQueried.push('global') // forced fallback
    } else {
      // merged
      scopesQueried.push('global')
      if (repoRootDetected) scopesQueried.push('repo')
    }

    // 2. Cache key includes scope + repo_root per the
    //    context-hash-includes-scope rule.
    const cacheKey = ctx.cache.keyFor({
      file_paths: context.file_paths ?? [],
      intent: context.intent ?? '',
      symbols: context.symbols ?? [],
      recent_diff: context.recent_diff ?? '',
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
    })

    const cached = ctx.cache.get<RetrieveContextOutput>(cacheKey)

    let result: RetrieveContextOutput
    let cacheHit = false

    if (cached) {
      result = cached.payload
      cacheHit = true
    } else {
      // 3. Fetch candidates from each kind across the queried scopes.
      const reader = ctx.corpusReader
      const intent = context.intent ?? ''

      const rulesAll: Rule[] = []
      const skillsAll: Skill[] = []
      const memoriesAll: Memory[] = []

      for (const s of scopesQueried) {
        rulesAll.push(...reader.fetchRules({ scope: s, intent, top_k: top_k_per_kind }))
        skillsAll.push(...reader.fetchSkills({ scope: s, intent, top_k: top_k_per_kind }))
        memoriesAll.push(...reader.fetchMemories({ scope: s, intent, top_k: top_k_per_kind }))
      }

      const overriddenIds: string[] = []
      const rules = mergeWithOverride(rulesAll, overriddenIds).slice(
        0,
        top_k_per_kind,
      )
      const skills = mergeWithOverride(skillsAll, []).slice(
        0,
        top_k_per_kind,
      )
      const memories = mergeWithOverride(memoriesAll, []).slice(
        0,
        top_k_per_kind,
      )

      const base: RetrieveContextBase = {
        rules,
        skills,
        memories,
        overridden_global_ids: overriddenIds,
        repo_root_detected: repoRootDetected,
        scopes_queried: scopesQueried,
      }

      // G5-M1: zero artifacts across every kind is a first-class outcome,
      // not bare empty arrays. The audit event below still fires with
      // rules_returned: [] so the no-match retrieval stays observable.
      const matchedAnything =
        rules.length + skills.length + memories.length > 0
      result = matchedAnything
        ? { ...base, match: 'matched' as const }
        : {
            ...base,
            match: 'none' as const,
            reason: 'no_match' as const,
            query_echo: {
              intent: context.intent ?? '',
              file_paths: context.file_paths ?? [],
              symbols: context.symbols ?? [],
            },
          }

      const envelope: CachedRetrieval<RetrieveContextOutput> = {
        payload: result,
        scopes_queried: scopesQueried,
        repo_root_detected: repoRootDetected,
        overridden_global_ids: overriddenIds,
        cached_at_ms: Date.now(),
      }
      ctx.cache.set(cacheKey, envelope)
    }

    // 4. Emit ONE audit event (not three — that's the whole point of this tool).
    const event: AuditEvent = {
      event_type: 'retrieve',
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash: cacheKey,
      repo_root_detected: result.repo_root_detected,
      scopes_queried: result.scopes_queried,
      rules_returned: [
        ...result.rules.map((r) => ({
          id: r.id,
          kind: 'rule' as const,
          scope: r.scope,
          domain: r.domain,
          score: 0,
          reason: 'merged',
        })),
        ...result.skills.map((s) => ({
          id: s.id,
          kind: 'skill' as const,
          scope: s.scope,
          domain: s.category,
          score: 0,
          reason: 'merged',
        })),
        ...result.memories.map((m) => ({
          id: m.id,
          kind: 'memory' as const,
          scope: m.scope,
          domain: m.kind,
          score: 0,
          reason: 'merged',
        })),
      ],
      overridden_global_ids: result.overridden_global_ids,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: cacheHit,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return result
  },
}

export default tool

/**
 * Apply the id-collision override rule across global+repo candidate lists.
 *
 * Items arrive already tagged with their scope. If two items share the same
 * id and one is repo, drop the global one and push its id onto `overriddenIds`.
 * Otherwise keep both. Ranking is preserved (the corpus reader returns lists
 * pre-sorted by severity * match-strength * recency); we just dedupe.
 */
function mergeWithOverride<T extends { id: string; scope: 'global' | 'repo' }>(
  items: T[],
  overriddenIds: string[],
): T[] {
  const byId = new Map<string, T>()
  for (const item of items) {
    const existing = byId.get(item.id)
    if (!existing) {
      byId.set(item.id, item)
      continue
    }
    // Collision. Repo wins. If existing is global and incoming is repo,
    // record the global id as overridden and replace it. If existing is
    // repo and incoming is global, drop the incoming (and record).
    if (existing.scope === 'global' && item.scope === 'repo') {
      overriddenIds.push(existing.id)
      byId.set(item.id, item)
    } else if (existing.scope === 'repo' && item.scope === 'global') {
      overriddenIds.push(item.id)
      // keep existing
    }
    // same-scope same-id is a corpus-validation issue; first-write wins.
  }
  return Array.from(byId.values())
}
