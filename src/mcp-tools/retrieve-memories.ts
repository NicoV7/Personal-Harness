/**
 * retrieve_memories — single-kind retrieval for memories (prior episodes).
 *
 * Memories are episodes — decisions, failures, discoveries, constraints — that
 * happened in the past and that future-you should not relitigate. Same scoping
 * and merge semantics as rules. Emits its own audit event.
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Memory,
  AuditEvent,
} from '../server/main.js'
import { detectRepoRoot } from '../server/scope/detect.js'
import type { CachedRetrieval } from '../server/cache/context-hash.js'

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
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { context, top_k, scope } = input

    const repoRootDetected =
      context.file_paths && context.file_paths.length > 0
        ? detectRepoRoot(context.file_paths)
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
      file_paths: context.file_paths ?? [],
      intent: context.intent ?? '',
      symbols: context.symbols ?? [],
      recent_diff: context.recent_diff ?? '',
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
    })

    const cached = ctx.cache.get<Memory[]>(cacheKey)
    let memories: Memory[]
    let cacheHit = false
    const overriddenIds: string[] = []

    if (cached) {
      memories = cached.payload
      cacheHit = true
    } else {
      const intent = context.intent ?? ''
      const candidates: Memory[] = []
      for (const s of scopesQueried) {
        candidates.push(...ctx.corpusReader.fetchMemories({ scope: s, intent, top_k }))
      }
      memories = mergeWithOverride(candidates, overriddenIds).slice(0, top_k)
      const envelope: CachedRetrieval<Memory[]> = {
        payload: memories,
        scopes_queried: scopesQueried,
        repo_root_detected: repoRootDetected,
        overridden_global_ids: overriddenIds,
        cached_at_ms: Date.now(),
      }
      ctx.cache.set(cacheKey, envelope)
    }

    const event: AuditEvent = {
      event_type: 'retrieve',
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash: cacheKey,
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
      rules_returned: memories.map((m) => ({
        id: m.id,
        kind: 'memory' as const,
        scope: m.scope,
        domain: m.kind,
        score: 0,
        reason: 'merged',
      })),
      overridden_global_ids: overriddenIds,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: cacheHit,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return memories
  },
}

export default tool

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
