/**
 * retrieve_skills — single-kind retrieval for skills only.
 *
 * Skills are procedures ("HOW to do Y step-by-step"). Same scoping/merge
 * semantics as rules and memories. Emits its own audit event.
 */

import { z } from 'zod'
import type { ToolContext, Skill, AuditEvent } from '../server/main.js'

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

export default {
  name: 'retrieve_skills',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (rawInput: unknown, ctx: ToolContext): Promise<Skill[]> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k, scope } = input

    const repoRootDetected =
      context.file_paths && context.file_paths.length > 0
        ? ctx.repoRootDetector(context.file_paths)
        : null

    const scopesQueried: Array<'global' | 'repo'> = []
    if (scope === 'global') scopesQueried.push('global')
    else if (scope === 'repo') {
      if (repoRootDetected) scopesQueried.push('repo')
      else scopesQueried.push('global')
    } else {
      scopesQueried.push('global')
      if (repoRootDetected) scopesQueried.push('repo')
    }

    const cacheKey = ctx.cache.keyFor({
      context,
      scope,
      repoRoot: repoRootDetected,
      kind: 'retrieve_skills',
      topK: top_k,
    })

    let skills = ctx.cache.get(cacheKey) as Skill[] | undefined
    let cacheHit = !!skills
    const overriddenIds: string[] = []

    if (!skills) {
      const candidates = await ctx.corpusReader.fetchSkills({
        context,
        scopes: scopesQueried,
        repoRoot: repoRootDetected,
      })
      skills = mergeWithOverride(candidates, overriddenIds).slice(0, top_k)
      ctx.cache.set(cacheKey, skills)
    }

    const event: AuditEvent = {
      event_type: 'retrieve',
      ts: new Date().toISOString(),
      agent_session_id: ctx.session?.agentSessionId ?? null,
      parent_agent_session_id: ctx.session?.parentAgentSessionId ?? null,
      subagent_class: ctx.session?.subagentClass ?? null,
      tool_call_id: ctx.toolCallId,
      context_hash: cacheKey,
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
      rules_returned: skills.map((s) => ({
        id: s.id,
        kind: 'skill' as const,
        scope: s.scope,
        domain: s.category,
        score: s.score ?? 0,
        reason: s.reason ?? 'merged',
      })),
      overridden_global_ids: overriddenIds,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: cacheHit,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return skills
  },
}

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
    if (existing.scope === 'global' && item.scope === 'repo') {
      overriddenIds.push(existing.id)
      byId.set(item.id, item)
    } else if (existing.scope === 'repo' && item.scope === 'global') {
      overriddenIds.push(item.id)
    }
  }
  return Array.from(byId.values())
}
