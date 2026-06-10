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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  AuditEvent,
} from '../server/main.js'
import { detectRepoRoot } from '../server/scope/detect.js'
import { ValidationError } from '../errors/index.js'

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
  already_existed: boolean
}

const DESCRIPTION =
  'Record a memory — a prior episode (decision, failure, discovery, constraint) ' +
  'that future-you should not relitigate. Server validates the frontmatter schema, ' +
  'determines the target path (repo corpus if detected, else global), writes the ' +
  'file, and returns the id and path. On id collision, returns the existing path ' +
  '(no overwrite). Rules and skills are NOT agent-writable; only memories.'

const tool: McpTool<unknown, RecordMemoryOutput> = {
  name: 'record_memory',
  description: DESCRIPTION,
  inputSchema: inputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<RecordMemoryOutput> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { memory, scope: requestedScope, context } = input

    // Determine scope.
    const repoRootDetected = context?.file_paths?.length
      ? detectRepoRoot(context.file_paths)
      : null

    let scope: 'global' | 'repo'

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
      scope = repoRootDetected ? 'repo' : 'global'
    }

    // Resolve target path and write.
    const yyyymm = memory.frontmatter.date.slice(0, 7) // "2026-06"
    const rootDir =
      scope === 'repo'
        ? join(repoRootDetected!, '.betterai')
        : ctx.config.BETTERAI_CORPUS_ROOT
    const targetPath = join(
      rootDir,
      'memories',
      yyyymm,
      `${memory.frontmatter.id}.md`,
    )

    let alreadyExisted = false
    if (existsSync(targetPath)) {
      // INSERT IGNORE: keep the existing file, return its path.
      alreadyExisted = true
    } else {
      mkdirSync(dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, serializeMemory(memory), { mode: 0o640 })
    }

    const cacheKey = ctx.cache.keyFor({
      file_paths: [targetPath],
      intent: `record_memory:${memory.frontmatter.id}`,
      symbols: [],
      recent_diff: '',
      repo_root_detected: repoRootDetected,
      scopes_queried: [scope],
    })

    const event: AuditEvent = {
      event_type: 'memory_recorded',
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash: cacheKey,
      repo_root_detected: repoRootDetected,
      scopes_queried: [scope],
      rules_returned: [
        {
          id: memory.frontmatter.id,
          kind: 'memory',
          scope,
          domain: memory.frontmatter.kind,
          score: 1,
          reason: alreadyExisted ? 'existing' : 'written',
        },
      ],
      overridden_global_ids: [],
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: false,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return {
      id: memory.frontmatter.id,
      path: targetPath,
      scope,
      already_existed: alreadyExisted,
    }
  },
}

export default tool

/**
 * Serialize a {frontmatter, body} pair to the on-disk markdown shape:
 *   ---
 *   key: value
 *   key2:
 *     - one
 *     - two
 *   ---
 *   <body>
 *
 * Hand-rolled to avoid pulling in `yaml` for the Phase 1.0 scaffold —
 * matches the YAML-ish parser in src/server/corpus/reader.ts.
 */
function serializeMemory(memory: {
  frontmatter: Record<string, unknown>
  body: string
}): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(memory.frontmatter)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`  - ${formatScalar(item)}`)
      }
    } else if (typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${formatScalar(v)}`)
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`)
    }
  }
  lines.push('---', '', memory.body)
  return lines.join('\n')
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  // Quote strings that look like other YAML types or have special chars.
  const s = String(v)
  if (
    /^(true|false|null|~|\d+(\.\d+)?)$/.test(s) ||
    /[:#\[\]{},&*!|>'"%@`]/.test(s) ||
    s.startsWith(' ') ||
    s.endsWith(' ')
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}
