/**
 * retrieve_rules — single-kind retrieval for rules only.
 *
 * Prefer retrieve_context for any multi-kind retrieval. This tool exists for
 * VSCode commands and fine-grained agent retrieval when only rules are wanted.
 * Emits its own 'retrieve' audit event (rules_returned populated, skills/
 * memories absent).
 */

import { z } from 'zod'
import type { ToolContext, Rule, AuditEvent } from '../server/main.js'

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

export default {
  name: 'retrieve_rules',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (rawInput: unknown, ctx: ToolContext): Promise<Rule[]> => {
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
      kind: 'retrieve_rules',
      topK: top_k,
    })

    let rules = ctx.cache.get(cacheKey) as Rule[] | undefined
    let cacheHit = !!rules
    const overriddenIds: string[] = []

    if (!rules) {
      const candidates = await ctx.corpusReader.fetchRules({
        context,
        scopes: scopesQueried,
        repoRoot: repoRootDetected,
      })
      rules = mergeWithOverride(candidates, overriddenIds).slice(0, top_k)
      ctx.cache.set(cacheKey, rules)
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
      rules_returned: rules.map((r) => ({
        id: r.id,
        kind: 'rule' as const,
        scope: r.scope,
        domain: r.domain,
        score: r.score ?? 0,
        reason: r.reason ?? 'merged',
      })),
      overridden_global_ids: overriddenIds,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: cacheHit,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return rules
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
