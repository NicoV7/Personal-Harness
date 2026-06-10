/**
 * check_file — run executable checks against a file's contents.
 *
 * Phase 1.0 only supports `check.kind=regex`. Per v4 design §"Reviewer
 * Concerns" and the dropped-shell-and-ts-module-checks memory, `shell` and
 * `ts-module` are dropped entirely. `ast-grep` is reserved for Phase 1.5 —
 * v1.0 rejects it with a clear, structured error so the caller knows it's a
 * known-not-yet-supported kind rather than an unknown configuration error.
 *
 * Input shape:
 *   - `path`: an absolute host path inside BETTERAI_PROJECTS_ROOT. The server
 *     reads the file via the read-only projects mount and runs all applicable
 *     regex checks against the contents.
 *   - `inline_contents`: the contents passed directly (the VSCode extension
 *     path, to avoid virtiofs/grpcfuse propagation lag on macOS Docker
 *     Desktop). Mutually exclusive with `path`.
 *
 * Output: a list of violations. Each violation is { rule_id, line, evidence,
 * severity, scope }. Always emits a single 'check' audit event.
 */

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type {
  ToolContext,
  ToolCallMeta,
  McpTool,
  Rule,
  AuditEvent,
} from '../server/main.js'
import { detectRepoRoot } from '../server/scope/detect.js'

const baseInputSchema = z.object({
  path: z.string().optional(),
  inline_contents: z.string().optional(),
  // Optional: filename hint when inline_contents is used, so applies_when
  // path globs can still match.
  inline_path_hint: z.string().optional(),
  // Optional context to drive scope detection.
  context: z
    .object({
      file_paths: z.array(z.string()).optional(),
    })
    .optional(),
  scope: z.enum(['merged', 'global', 'repo']).optional().default('merged'),
})

// `path` XOR `inline_contents` — enforced in handler so the JSON schema
// shape exposed to MCP clients stays a plain object (no `allOf`/`refine`
// that some MCP clients render poorly).
const inputSchema = baseInputSchema

type Input = z.infer<typeof inputSchema>

export interface Violation {
  rule_id: string
  scope: 'global' | 'repo'
  line: number
  evidence: string
  severity: 'low' | 'medium' | 'high'
  domain: string
}

interface CheckFileOutput {
  violations: Violation[]
  skipped_checks: Array<{ rule_id: string; reason: string }>
}

const DESCRIPTION =
  'Run the corpus\'s executable rule checks against a file and return violations. ' +
  'v1.0 supports only regex checks; ast-grep checks are reserved for a future ' +
  'release and skipped with a structured note. Pass `path` for an absolute host ' +
  'path inside the projects mount, OR `inline_contents` to check buffer contents ' +
  'directly (avoids macOS Docker virtiofs propagation lag). One audit event per call.'

const tool: McpTool<unknown, CheckFileOutput> = {
  name: 'check_file',
  description: DESCRIPTION,
  inputSchema: baseInputSchema.shape,

  handler: async (
    rawInput: unknown,
    ctx: ToolContext,
    meta: ToolCallMeta,
  ): Promise<CheckFileOutput> => {
    const startedAt = performance.now()
    const input: Input = inputSchema.parse(rawInput)
    const { path, inline_contents, inline_path_hint, context, scope } = input

    // Enforce the XOR invariant in the handler (kept out of the JSON schema
    // so the exposed inputSchema stays a plain object — see baseInputSchema).
    if (Boolean(path) === Boolean(inline_contents)) {
      throw new ValidationError(
        'exactly one of `path` or `inline_contents` must be provided',
      )
    }

    // Resolve repo root from either explicit context.file_paths or, failing
    // that, the file path itself (when caller passed `path`).
    const detectionPaths =
      context?.file_paths ??
      (path ? [path] : inline_path_hint ? [inline_path_hint] : [])
    const repoRootDetected = detectionPaths.length
      ? detectRepoRoot(detectionPaths)
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

    // Read file contents if `path` was provided. The host→container path
    // translation lives at the container mount layer; here we treat `path`
    // as a path readable by this process.
    const filePath = path ?? inline_path_hint ?? '<inline>'
    const contents =
      inline_contents !== undefined
        ? inline_contents
        : readFileSync(path!, 'utf8')

    // Collect every rule that has a `check` block, then filter to the
    // scopes we're querying (the reader returns rules tagged with .scope).
    const allCheckable: Rule[] = ctx.corpusReader.fetchCheckableRules()
    const candidateRules = allCheckable.filter((r: Rule) =>
      scopesQueried.includes(r.scope),
    )

    // Honor v4.1 override semantics: repo wins on id collision.
    const overriddenIds: string[] = []
    const rules = mergeWithOverride(candidateRules, overriddenIds)

    const violations: Violation[] = []
    const skipped: Array<{ rule_id: string; reason: string }> = []

    for (const rule of rules) {
      const check = rule.check
      if (!check) continue

      if (check.kind === 'regex') {
        // Compile once to validate the pattern; per-line matching uses fresh
        // RegExp instances to keep stateless semantics for /g flags etc.
        try {
          new RegExp(check.pattern)
        } catch (err) {
          skipped.push({
            rule_id: rule.id,
            reason: `invalid regex: ${(err as Error).message}`,
          })
          continue
        }

        // Walk per-line to recover line numbers and bounded evidence snippets.
        const lines = contents.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          const lineRe = new RegExp(check.pattern)
          if (lineRe.test(line)) {
            violations.push({
              rule_id: rule.id,
              scope: rule.scope,
              line: i + 1,
              evidence: truncate(line, 240),
              severity: rule.severity,
              domain: rule.domain,
            })
          }
        }
      } else if (check.kind === 'ast-grep') {
        // v1.0 reject — see file header.
        skipped.push({
          rule_id: rule.id,
          reason:
            'ast-grep checks are not supported in v1.0; reserved for Phase 1.5',
        })
      } else {
        skipped.push({
          rule_id: rule.id,
          reason: `unknown check.kind="${(check as { kind: string }).kind}"`,
        })
      }
    }

    const contextHash = ctx.cache.keyFor({
      file_paths: [filePath],
      intent: 'check_file',
      symbols: [],
      recent_diff: '',
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
    })

    const event: AuditEvent = {
      event_type: 'check',
      ts: new Date().toISOString(),
      agent_session_id: meta.agent_session_id,
      parent_agent_session_id: meta.parent_agent_session_id,
      subagent_class: meta.subagent_class,
      tool_call_id: meta.tool_call_id,
      context_hash: contextHash,
      repo_root_detected: repoRootDetected,
      scopes_queried: scopesQueried,
      rules_returned: violations.map((v) => ({
        id: v.rule_id,
        kind: 'rule' as const,
        scope: v.scope,
        domain: v.domain,
        score: 1,
        reason: 'violation',
      })),
      overridden_global_ids: overriddenIds,
      latency_ms: Math.round(performance.now() - startedAt),
      cache_hit: false,
      downstream_apply_event_id: null,
      downstream_commit_sha: null,
      downstream_violations: null,
    }
    ctx.auditLog(event)

    return { violations, skipped_checks: skipped }
  },
}

export default tool

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function mergeWithOverride(
  items: Rule[],
  overriddenIds: string[],
): Rule[] {
  const byId = new Map<string, Rule>()
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
