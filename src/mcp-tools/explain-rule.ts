/**
 * explain_rule — return the full markdown body of a rule by id.
 *
 * Used by VSCode (rule explorer click) and by agents that received a rule
 * summary in retrieve_context output and want the full body. Always emits a
 * single 'explain' audit event.
 *
 * Scope resolution: if a repo root is detected and the repo corpus has a rule
 * with this id, return the repo version (override semantics). Otherwise return
 * the global version. If neither exists, throw RuleNotFoundError.
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Rule,
  AuditEvent,
} from '../server/main.js'

const inputSchema = z.object({
  rule_id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'must be kebab-case'),
  // Optional context to resolve overrides correctly.
  context: z
    .object({
      file_paths: z.array(z.string()).optional(),
    })
    .optional(),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

type Input = z.infer<typeof inputSchema>

const DESCRIPTION =
  'Return the full markdown body of a rule by id. Use this when retrieve_context ' +
  'returned a rule summary and you need the complete body (worked examples, ' +
  'anti-patterns, etc.). Honors the v4.1 scoping override: if a repo version of ' +
  'the rule exists, returns that; otherwise returns the global version.'

const tool: McpTool<unknown, Rule> = {
  name: 'explain_rule',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<Rule> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { rule_id, context, scope } = input

    // Repo detection via the DI detector — `scopes_queried` must report
    // only corpora we can actually read, so the repo scope is gated on
    // <repo-root>/.betterai existing as a directory (mirrors the
    // orchestrator's gating).
    const detection = context?.file_paths?.length
      ? ctx.repoRootDetector.detectFromBatch(context.file_paths)
      : { repo_root: null, has_betterai_dir: false }
    const repoRootDetected = detection.repo_root
    const repoCorpusReadable =
      repoRootDetected !== null && detection.has_betterai_dir

    const scopesQueried: Array<'global' | 'repo'> = []
    if (scope === 'global') scopesQueried.push('global')
    else if (scope === 'repo') {
      if (repoCorpusReadable) scopesQueried.push('repo')
      else scopesQueried.push('global')
    } else {
      scopesQueried.push('global')
      if (repoCorpusReadable) scopesQueried.push('repo')
    }

    // Delegate the lookup to the orchestrator: it constructs a per-call
    // CorpusReader scoped to global + the detected repo corpus and the
    // merged snapshot returns the repo version preferentially (v4.1
    // id-collision override). For scope: 'global' we pass no repo hint
    // so the lookup stays global-only.
    const rule = ctx.orchestrator.explainRule(
      rule_id,
      scope !== 'global' && scopesQueried.includes('repo')
        ? context?.file_paths?.[0]
        : undefined,
    )

    // When the caller asked for repo scope ONLY, a global-scoped survivor
    // must not be returned (and must not appear in the audit as if the
    // repo corpus produced it).
    const resolved =
      scope === 'repo' && scopesQueried.includes('repo') && rule?.scope !== 'repo'
        ? undefined
        : rule

    if (!resolved) {
      throw new RuleNotFoundError(
        `rule "${rule_id}" not found in scopes [${scopesQueried.join(', ')}]`,
      )
    }

    // We can't cheaply check whether a global version was overridden without
    // a second lookup; the merged snapshot already collapses the override
    // and returns the surviving rule. If the surviving rule is
    // repo-scoped and we queried global too, record the override.
    const overriddenIds: string[] =
      scopesQueried.includes('global') &&
      scopesQueried.includes('repo') &&
      resolved.scope === 'repo'
        ? [resolved.id]
        : []

    const cacheKey = ctx.cache.keyFor({
      file_paths: context?.file_paths ?? [],
      intent: `explain_rule:${rule_id}`,
      symbols: [],
      recent_diff: '',
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
    })

    const event: AuditEvent = {
      event_type: 'explain',
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash: cacheKey,
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
      rules_returned: [
        {
          id: resolved.id,
          kind: 'rule',
          scope: resolved.scope,
          domain: resolved.domain,
          score: 1,
          reason: 'explain',
        },
      ],
      overridden_global_ids: overriddenIds,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: false,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return resolved
  },
}

export default tool

class RuleNotFoundError extends Error {
  readonly code = 'RULE_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'RuleNotFoundError'
  }
}
