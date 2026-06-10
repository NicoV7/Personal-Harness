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
import { detectRepoRoot } from '../server/scope/detect.js'

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

    const repoRootDetected = context?.file_paths?.length
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

    // Ask the corpus reader for the rule body. The reader returns the
    // repo version preferentially when both scopes are loaded.
    const rule = ctx.corpusReader.fetchRuleById(rule_id)

    if (!rule) {
      throw new RuleNotFoundError(
        `rule "${rule_id}" not found in scopes [${scopesQueried.join(', ')}]`,
      )
    }

    // We can't cheaply check whether a global version was overridden without
    // a second lookup; fetchRuleById's contract already collapses the
    // override and returns the surviving rule. If the surviving rule is
    // repo-scoped and we queried global too, record the override.
    const overriddenIds: string[] =
      scopesQueried.includes('global') &&
      scopesQueried.includes('repo') &&
      rule.scope === 'repo'
        ? [rule.id]
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

export default tool

class RuleNotFoundError extends Error {
  readonly code = 'RULE_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'RuleNotFoundError'
  }
}
