/**
 * record_memory — write a memory to the corpus.
 *
 * Memories are agent-writable because episodes happen during agent work
 * (per multi-agent eng review §1.4). Rules and skills stay human-driven.
 *
 * Scope semantics (v4.1):
 *   - default: 'repo' if a repo root is detectable from the call's context,
 *     else 'global'.
 *   - explicit 'repo' when no repo root is detectable → validation error.
 *   - explicit 'global' always works.
 *
 * Write path:
 *   global → ~/.betterai/memories/<yyyy-mm>/<id>.md   (container: /data/memories/...)
 *   repo   → <repo-root>/.betterai/memories/<yyyy-mm>/<id>.md
 *
 * On id collision: INSERT IGNORE — return the existing path, do NOT overwrite
 * (per §1.7 failure modes registry, row "Two subagents call record_memory with
 * same id concurrently").
 */

import { z } from 'zod'
import type { ToolContext, AuditEvent } from '../server/main.js'

const memoryFrontmatterSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'must be kebab-case'),
    title: z.string().min(1).max(80),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO date YYYY-MM-DD'),
    project: z.string().min(1),
    kind: z.enum(['decision', 'failure', 'discovery', 'constraint']),
    context_keywords: z.array(z.string().min(1)).min(1),
    durability: z.enum(['short', 'medium', 'long']),
    auto_captured: z.boolean(),
    applies_to_future_intents: z.array(z.string()).optional(),
    related_rules: z.array(z.string()).optional(),
    related_memories: z.array(z.string()).optional(),
    expires_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()

const memorySchema = z.object({
  frontmatter: memoryFrontmatterSchema,
  body: z.string().min(1),
})

const inputSchema = z.object({
  memory: memorySchema,
  scope: z.enum(['global', 'repo']).optional(),
  // Optional context to drive repo-root detection when scope is omitted.
  context: z
    .object({
      file_paths: z.array(z.string()).optional(),
    })
    .optional(),
})

type Input = z.infer<typeof inputSchema>

interface RecordMemoryOutput {
  id: string
  path: string
  scope: 'global' | 'repo'
  scope_fallback?: 'global' // present when caller asked for repo but no repo was detectable
  already_existed: boolean
}

const DESCRIPTION =
  'Record a memory — a prior episode (decision, failure, discovery, constraint) ' +
  'that future-you should not relitigate. Server validates the frontmatter schema, ' +
  'determines the target path (repo corpus if detected, else global), writes the ' +
  'file, and returns the id and path. On id collision, returns the existing path ' +
  '(no overwrite). Rules and skills are NOT agent-writable; only memories.'

export default {
  name: 'record_memory',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<RecordMemoryOutput> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { memory, scope: requestedScope, context } = input

    // Run the corpusReader's schema/cross-ref validator as a second gate
    // beyond the Zod check (it may enforce things like related-id existence).
    const validation = await ctx.corpusReader.validateMemory(memory)
    if (!validation.ok) {
      throw new ValidationError(
        `memory schema validation failed: ${validation.errors.join('; ')}`,
      )
    }

    // Determine scope.
    const repoRootDetected = context?.file_paths?.length
      ? ctx.repoRootDetector(context.file_paths)
      : null

    let scope: 'global' | 'repo'
    let scopeFallback: 'global' | undefined

    if (requestedScope === 'repo') {
      if (!repoRootDetected) {
        // Per v4.1 §5: explicit scope=repo with no repo root is a validation
        // error, returned structured (not thrown as an exception).
        throw new ValidationError(
          'scope="repo" requested but no repo root was detected from context.file_paths; ' +
            'pass file_paths inside a git repo with a .betterai/ directory, or use scope="global"',
        )
      }
      scope = 'repo'
    } else if (requestedScope === 'global') {
      scope = 'global'
    } else {
      // Default: repo if detectable, else global.
      if (repoRootDetected) {
        scope = 'repo'
      } else {
        scope = 'global'
      }
    }

    // Resolve target path and write.
    const yyyymm = memory.frontmatter.date.slice(0, 7) // "2026-06"
    const writeResult = await ctx.corpusReader.writeMemory({
      memory,
      scope,
      repoRoot: scope === 'repo' ? repoRootDetected : null,
      yyyymm,
    })

    const event: AuditEvent = {
      event_type: 'memory_recorded',
      ts: new Date().toISOString(),
      agent_session_id: ctx.session?.agentSessionId ?? null,
      parent_agent_session_id: ctx.session?.parentAgentSessionId ?? null,
      subagent_class: ctx.session?.subagentClass ?? null,
      tool_call_id: ctx.toolCallId,
      context_hash: ctx.cache.keyFor({
        kind: 'record_memory',
        memoryId: memory.frontmatter.id,
        scope,
      }),
      repo_root_detected: repoRootDetected,
      scopes_queried: [scope],
      rules_returned: [
        {
          id: memory.frontmatter.id,
          kind: 'memory',
          scope,
          domain: memory.frontmatter.kind,
          score: 1,
          reason: writeResult.alreadyExisted ? 'existing' : 'written',
        },
      ],
      overridden_global_ids: [],
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: false,
      scope_fallback: scopeFallback ?? null,
      memory_path: writeResult.path,
      memory_already_existed: writeResult.alreadyExisted,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return {
      id: memory.frontmatter.id,
      path: writeResult.path,
      scope,
      ...(scopeFallback ? { scope_fallback: scopeFallback } : {}),
      already_existed: writeResult.alreadyExisted,
    }
  },
}

class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
