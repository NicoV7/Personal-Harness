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
import type { ToolContext, Rule, AuditEvent } from '../server/main.js'

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

export default {
  name: 'explain_rule',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (rawInput: unknown, ctx: ToolContext): Promise<Rule> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { rule_id, context, scope } = input

    const repoRootDetected = context?.file_paths?.length
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

    // Ask the corpus reader for the rule body across scopes. The reader
    // returns the repo version preferentially if both exist.
    const rule = await ctx.corpusReader.fetchRuleById({
      ruleId: rule_id,
      scopes: scopesQueried,
      repoRoot: repoRootDetected,
    })

    if (!rule) {
      throw new RuleNotFoundError(
        `rule "${rule_id}" not found in scopes [${scopesQueried.join(', ')}]`,
      )
    }

    // If both scopes were searched and the returned rule is repo, record the
    // global override (if a global with same id exists) for audit visibility.
    const overriddenIds: string[] = []
    if (
      scopesQueried.includes('global') &&
      scopesQueried.includes('repo') &&
      rule.scope === 'repo'
    ) {
      const globalExists = await ctx.corpusReader.ruleExists({
        ruleId: rule_id,
        scope: 'global',
      })
      if (globalExists) overriddenIds.push(rule_id)
    }

    const event: AuditEvent = {
      event_type: 'explain',
      ts: new Date().toISOString(),
      agent_session_id: ctx.session?.agentSessionId ?? null,
      parent_agent_session_id: ctx.session?.parentAgentSessionId ?? null,
      subagent_class: ctx.session?.subagentClass ?? null,
      tool_call_id: ctx.toolCallId,
      context_hash: ctx.cache.keyFor({
        kind: 'explain_rule',
        ruleId: rule_id,
        scope,
        repoRoot: repoRootDetected,
      }),
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
      rules_returned: [
        {
          id: rule.id,
          kind: 'rule',
          scope: rule.scope,
          domain: rule.domain,
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

    return rule
  },
}

class RuleNotFoundError extends Error {
  readonly code = 'RULE_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'RuleNotFoundError'
  }
}
