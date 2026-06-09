/**
 * retrieve_context — THE canonical subagent entry point.
 *
 * One call, one audit event, three lists. Aggregates rules + skills + memories
 * for the agent's current intent. Implements the v4.1 scoping algorithm:
 *
 *   1. Detect repo root from context.file_paths[0] (via ctx.repoRootDetector).
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
  Rule,
  Skill,
  Memory,
  AuditEvent,
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
  top_k_per_kind: z.number().int().positive().max(32).optional().default(4),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

type Input = z.infer<typeof inputSchema>

interface RetrieveContextOutput {
  rules: Rule[]
  skills: Skill[]
  memories: Memory[]
  overridden_global_ids: string[]
  repo_root_detected: string | null
  scopes_queried: Array<'global' | 'repo'>
}

const DESCRIPTION =
  'ALWAYS call retrieve_context as your first action on any code task. ' +
  'Returns the rules, skills, and prior episodes (memories) relevant to your ' +
  'current intent — merged across the global corpus (~/.betterai/) and the ' +
  'current repo corpus (<repo-root>/.betterai/) if one is detected. Pass the ' +
  'file paths you intend to edit, your stated intent, and any symbols in scope. ' +
  'One call, one audit event, three lists. Cheaper than calling ' +
  'retrieve_rules/retrieve_skills/retrieve_memories separately.'

export default {
  name: 'retrieve_context',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<RetrieveContextOutput> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k_per_kind, scope } = input

    // 1. Detect repo root from the first file path. Falls back to null if no
    //    path was passed or the path is not inside a git repo with .betterai/.
    const repoRootDetected =
      context.file_paths && context.file_paths.length > 0
        ? ctx.repoRootDetector(context.file_paths)
        : null

    // Which corpora we actually query depends on `scope` and whether a repo
    // root was detected. `scope=repo` with no repo root = global-only fallback,
    // logged via scopes_queried so the audit reader can see it.
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
    //    context-hash-includes-scope rule. ctx.cache hashes context + these.
    const cacheKey = ctx.cache.keyFor({
      context,
      scope,
      repoRoot: repoRootDetected,
      kind: 'retrieve_context',
      topKPerKind: top_k_per_kind,
    })

    const cached = ctx.cache.get(cacheKey) as
      | (RetrieveContextOutput & { __cached?: true })
      | undefined

    let result: RetrieveContextOutput
    let cacheHit = false

    if (cached) {
      result = cached
      cacheHit = true
    } else {
      // 3. Fetch candidates from each kind across the queried scopes.
      const reader = ctx.corpusReader

      const [rulesAll, skillsAll, memoriesAll] = await Promise.all([
        reader.fetchRules({
          context,
          scopes: scopesQueried,
          repoRoot: repoRootDetected,
        }),
        reader.fetchSkills({
          context,
          scopes: scopesQueried,
          repoRoot: repoRootDetected,
        }),
        reader.fetchMemories({
          context,
          scopes: scopesQueried,
          repoRoot: repoRootDetected,
        }),
      ])

      const overriddenIds: string[] = []
      const rules = mergeWithOverride(rulesAll, overriddenIds).slice(
        0,
        top_k_per_kind,
      )
      const skills = mergeWithOverride(skillsAll, overriddenIds).slice(
        0,
        top_k_per_kind,
      )
      const memories = mergeWithOverride(memoriesAll, overriddenIds).slice(
        0,
        top_k_per_kind,
      )

      result = {
        rules,
        skills,
        memories,
        overridden_global_ids: overriddenIds,
        repo_root_detected: repoRootDetected,
        scopes_queried: scopesQueried,
      }

      ctx.cache.set(cacheKey, result)
    }

    // 4. Emit ONE audit event (not three — that's the whole point of this tool).
    const event: AuditEvent = {
      event_type: 'retrieve',
      ts: new Date().toISOString(),
      agent_session_id: ctx.session?.agentSessionId ?? null,
      parent_agent_session_id: ctx.session?.parentAgentSessionId ?? null,
      subagent_class: ctx.session?.subagentClass ?? null,
      tool_call_id: ctx.toolCallId,
      context_hash: cacheKey,
      repo_root_detected: result.repo_root_detected,
      scopes_queried: result.scopes_queried,
      rules_returned: [
        ...result.rules.map((r) => ({
          id: r.id,
          kind: 'rule' as const,
          scope: r.scope,
          domain: r.domain,
          score: r.score ?? 0,
          reason: r.reason ?? 'merged',
        })),
        ...result.skills.map((s) => ({
          id: s.id,
          kind: 'skill' as const,
          scope: s.scope,
          domain: s.category,
          score: s.score ?? 0,
          reason: s.reason ?? 'merged',
        })),
        ...result.memories.map((m) => ({
          id: m.id,
          kind: 'memory' as const,
          scope: m.scope,
          domain: m.kind,
          score: m.score ?? 0,
          reason: m.reason ?? 'merged',
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
