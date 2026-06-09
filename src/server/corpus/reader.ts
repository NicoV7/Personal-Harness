// src/server/corpus/reader.ts
//
// Read frontmatter + body from rules/skills/memories markdown.
//
// Mirrors rules/_meta/schema.md:
//   - Rules: <root>/rules/<CATEGORY>/<domain>/<id>.md
//   - Skills: <root>/skills/<category>/<id>.md
//   - Memories: <root>/memories/<yyyy-mm>/<id>.md
//
// "scope" is implicit from which root the file lives under (no
// `scope:` field in frontmatter); the reader stamps it onto every record
// at parse time.
//
// Override semantics (per rules/_meta/conflict-resolution.md):
//   when the same id appears in both scopes, the repo version replaces
//   the global version.  The merge happens in this reader so downstream
//   retrieval code never has to reason about it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";

export type Scope = "global" | "repo";
export type ArtifactKind = "rule" | "skill" | "memory";

// ---- Frontmatter schemas (the runtime safety net) ----------------------

const RuleCategory = z.enum([
  "STANDARDS",
  "PROCESS",
  "PATTERNS",
  "ARCHITECTURE",
  "DOCUMENTATION",
]);
const Severity = z.enum(["low", "medium", "high"]);

const AppliesWhen = z
  .object({
    paths: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    intents: z.array(z.string()).optional(),
  })
  .partial()
  .optional();

const RuleFrontmatter = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: RuleCategory,
  domain: z.string().min(1),
  severity: Severity,
  created: z.string().min(1),
  applies_when: AppliesWhen,
  check: z
    .object({
      kind: z.enum(["regex", "ast-grep"]),
      pattern: z.string(),
    })
    .optional(),
  fix_template: z.string().optional(),
  source: z.string().optional(),
  related: z.array(z.string()).optional(),
  last_fired: z.string().optional(),
  fire_count: z.number().optional(),
});

const SkillFrontmatter = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().min(1),
  when_to_use: z.string().min(1),
  steps_count: z.number(),
  created: z.string().min(1),
  estimated_minutes: z.number().optional(),
  applies_when: AppliesWhen,
  codified_from: z.string().optional(),
  related_rules: z.array(z.string()).optional(),
  related_skills: z.array(z.string()).optional(),
});

const MemoryFrontmatter = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  date: z.string().min(1),
  project: z.string().min(1),
  kind: z.enum(["decision", "failure", "discovery", "constraint"]),
  context_keywords: z.array(z.string()),
  durability: z.enum(["short", "medium", "long"]),
  auto_captured: z.boolean(),
  applies_to_future_intents: z.array(z.string()).optional(),
  related_rules: z.array(z.string()).optional(),
  related_memories: z.array(z.string()).optional(),
  expires_on: z.string().optional(),
});

// ---- Public types ------------------------------------------------------

export interface AppliesWhenT {
  paths?: string[];
  symbols?: string[];
  intents?: string[];
}

export interface Rule {
  id: string;
  title: string;
  category: z.infer<typeof RuleCategory>;
  domain: string;
  severity: z.infer<typeof Severity>;
  created: string;
  applies_when?: AppliesWhenT;
  check?: { kind: "regex" | "ast-grep"; pattern: string };
  fix_template?: string;
  source?: string;
  related?: string[];
  scope: Scope;
  /** Absolute host path the rule was loaded from. */
  source_path: string;
  body: string;
}

export interface Skill {
  id: string;
  title: string;
  category: string;
  when_to_use: string;
  steps_count: number;
  created: string;
  applies_when?: AppliesWhenT;
  related_rules?: string[];
  related_skills?: string[];
  scope: Scope;
  source_path: string;
  body: string;
}

export interface Memory {
  id: string;
  title: string;
  date: string;
  project: string;
  kind: "decision" | "failure" | "discovery" | "constraint";
  context_keywords: string[];
  durability: "short" | "medium" | "long";
  auto_captured: boolean;
  applies_to_future_intents?: string[];
  related_rules?: string[];
  scope: Scope;
  source_path: string;
  body: string;
}

export interface ValidationIssue {
  path: string;
  kind: ArtifactKind | "unknown";
  message: string;
}

export interface CorpusSnapshot {
  rules: Rule[];
  skills: Skill[];
  memories: Memory[];
  /**
   * Ids that exist in BOTH scopes; the repo version is what's in
   * `rules`/`skills`/`memories`, the global version was dropped.  Echoed
   * into the audit event's `overridden_global_ids`.
   */
  overridden_global_ids: string[];
  scopes_loaded: Scope[];
  issues: ValidationIssue[];
}

export interface CorpusReaderOptions {
  /** Path to the global corpus root (typically /data inside container). */
  globalRoot: string;
  /** Optional repo corpus root, e.g. `<repo>/.betterai`. */
  repoRoot?: string | null;
}

// ---- Frontmatter parser ------------------------------------------------

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseDoc(raw: string): ParsedDoc | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const frontmatter = parseYamlLike(m[1]);
  return { frontmatter, body: m[2] };
}

/**
 * Minimal YAML-ish parser.  We deliberately do NOT depend on `js-yaml`
 * at this stage — the frontmatter we accept is a small, well-known
 * shape (key: scalar | list | nested-object) and a hand-rolled parser
 * avoids a runtime dependency for the Phase 1.0 scaffold.
 *
 * TODO(phase-1.1): swap for `yaml` package once it's locked in
 *                  package.json by Team A — the hand-rolled path will
 *                  bit-rot the moment someone writes a multi-line scalar.
 */
function parseYamlLike(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = src.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === "" || rest === "|" || rest === ">") {
      // Block scalar or nested object — gather indented continuation lines.
      const block: string[] = [];
      const childKv: Record<string, unknown> = {};
      i += 1;
      let mode: "block" | "object" | "unknown" = "unknown";
      while (i < lines.length) {
        const next = lines[i];
        if (!next.startsWith("  ") && next.trim() !== "") break;
        const stripped = next.replace(/^ {2}/, "");
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(stripped);
        if (kv && (mode === "unknown" || mode === "object")) {
          mode = "object";
          childKv[kv[1]] = parseScalar(kv[2]);
        } else {
          mode = mode === "object" ? mode : "block";
          if (stripped.startsWith("- ")) {
            // list item under a key
            (out[key] as unknown[] | undefined) ??
              (out[key] = [] as unknown[]);
            (out[key] as unknown[]).push(parseScalar(stripped.slice(2)));
          } else {
            block.push(stripped);
          }
        }
        i += 1;
      }
      if (mode === "object") out[key] = childKv;
      else if (block.length) out[key] = block.join("\n");
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => parseScalar(s.trim()))
        .filter((s) => s !== "");
      i += 1;
      continue;
    }
    out[key] = parseScalar(rest);
    i += 1;
  }
  return out;
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---- Walkers -----------------------------------------------------------

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "_meta") continue;
        stack.push(full);
      } else if (st.isFile() && name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  return out;
}

// ---- Per-kind loaders --------------------------------------------------

interface LoadCtx {
  root: string;
  scope: Scope;
  issues: ValidationIssue[];
}

function loadRules(ctx: LoadCtx): Rule[] {
  const dir = join(ctx.root, "rules");
  const out: Rule[] = [];
  for (const path of walkMarkdown(dir)) {
    const raw = readFileSync(path, "utf8");
    const parsed = parseDoc(raw);
    if (!parsed) {
      ctx.issues.push({ path, kind: "rule", message: "no frontmatter found" });
      continue;
    }
    const result = RuleFrontmatter.safeParse(parsed.frontmatter);
    if (!result.success) {
      ctx.issues.push({
        path,
        kind: "rule",
        message: `frontmatter invalid: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    out.push({
      ...result.data,
      scope: ctx.scope,
      source_path: path,
      body: parsed.body,
    });
  }
  return out;
}

function loadSkills(ctx: LoadCtx): Skill[] {
  const dir = join(ctx.root, "skills");
  const out: Skill[] = [];
  for (const path of walkMarkdown(dir)) {
    const raw = readFileSync(path, "utf8");
    const parsed = parseDoc(raw);
    if (!parsed) {
      ctx.issues.push({ path, kind: "skill", message: "no frontmatter found" });
      continue;
    }
    const result = SkillFrontmatter.safeParse(parsed.frontmatter);
    if (!result.success) {
      ctx.issues.push({
        path,
        kind: "skill",
        message: `frontmatter invalid: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    out.push({
      ...result.data,
      scope: ctx.scope,
      source_path: path,
      body: parsed.body,
    });
  }
  return out;
}

function loadMemories(ctx: LoadCtx): Memory[] {
  const dir = join(ctx.root, "memories");
  const out: Memory[] = [];
  for (const path of walkMarkdown(dir)) {
    const raw = readFileSync(path, "utf8");
    const parsed = parseDoc(raw);
    if (!parsed) {
      ctx.issues.push({ path, kind: "memory", message: "no frontmatter found" });
      continue;
    }
    const result = MemoryFrontmatter.safeParse(parsed.frontmatter);
    if (!result.success) {
      ctx.issues.push({
        path,
        kind: "memory",
        message: `frontmatter invalid: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      });
      continue;
    }
    out.push({
      ...result.data,
      scope: ctx.scope,
      source_path: path,
      body: parsed.body,
    });
  }
  return out;
}

// ---- Reader facade -----------------------------------------------------

export class CorpusReader {
  constructor(private readonly opts: CorpusReaderOptions) {}

  /**
   * Read both scopes (if present), merge by id-collision-override, and
   * return a snapshot.  Validation issues are collected — they do not
   * throw — so a malformed repo file cannot crash the global load.
   *
   * Per .betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline
   * this method MUST work without the server running: it touches only the
   * filesystem and Zod.
   */
  read(): CorpusSnapshot {
    const issues: ValidationIssue[] = [];
    const scopes_loaded: Scope[] = [];
    let globalRules: Rule[] = [];
    let globalSkills: Skill[] = [];
    let globalMemories: Memory[] = [];
    let repoRules: Rule[] = [];
    let repoSkills: Skill[] = [];
    let repoMemories: Memory[] = [];

    if (existsSync(this.opts.globalRoot)) {
      const ctx: LoadCtx = {
        root: this.opts.globalRoot,
        scope: "global",
        issues,
      };
      globalRules = loadRules(ctx);
      globalSkills = loadSkills(ctx);
      globalMemories = loadMemories(ctx);
      scopes_loaded.push("global");
    }

    if (this.opts.repoRoot && existsSync(this.opts.repoRoot)) {
      const ctx: LoadCtx = { root: this.opts.repoRoot, scope: "repo", issues };
      repoRules = loadRules(ctx);
      repoSkills = loadSkills(ctx);
      repoMemories = loadMemories(ctx);
      scopes_loaded.push("repo");
    }

    const overridden_global_ids: string[] = [];
    const rules = mergeByIdOverride(
      globalRules,
      repoRules,
      overridden_global_ids,
    );
    const skills = mergeByIdOverride(globalSkills, repoSkills, []);
    const memories = mergeByIdOverride(globalMemories, repoMemories, []);

    return {
      rules,
      skills,
      memories,
      overridden_global_ids,
      scopes_loaded,
      issues,
    };
  }

  /**
   * Reduce a CorpusSnapshot to a single artifact lookup by id+kind.
   * Used by `explain_rule`.
   */
  findRule(snapshot: CorpusSnapshot, id: string): Rule | undefined {
    return snapshot.rules.find((r) => r.id === id);
  }
}

/**
 * Merge two lists by id: repo replaces global.  We only record overrides
 * for the `rules` kind (this matches the audit-event schema, which has
 * `overridden_global_ids` at the top level — per v4.1 §6).
 */
function mergeByIdOverride<T extends { id: string }>(
  globalItems: T[],
  repoItems: T[],
  collectOverrides: string[],
): T[] {
  const repoIds = new Set(repoItems.map((r) => r.id));
  const surviving: T[] = [];
  for (const g of globalItems) {
    if (repoIds.has(g.id)) {
      collectOverrides.push(g.id);
      continue;
    }
    surviving.push(g);
  }
  return [...surviving, ...repoItems];
}

/**
 * Convenience accessor used by tests + the validator: list every file
 * under the corpus root, no parsing.  Cheap.
 */
export function listCorpusFiles(root: string): string[] {
  return walkMarkdown(root).map((p) => relative(root, p).split(sep).join("/"));
}
