// BetterAI corpus schema validator.
//
// Responsibilities:
//   1. Parse YAML frontmatter + body from a markdown artifact.
//   2. Validate rule / skill / memory frontmatter per docs/design/v4-design.md
//      "The Rule Shape" + the multi-agent eng review §1.2/§1.3.
//   3. Validate required H2 sections appear in the body in order.
//   4. Walk a corpus root and aggregate per-file results into a corpus report.
//   5. Validate audit events per the multi-agent eng review §1.4 / v4.1 §6.
//
// This module is used by:
//   - the offline `betterai validate` CLI verb (per .betterai cli-read-ops-work-offline)
//   - the server's boot-time corpus reader (Team B)
//   - the colocated Vitest suite rule-schema.test.ts (35 cases)
//
// No third-party YAML lib — frontmatter is small, hand-parsed against a tiny
// grammar. The corpus schema is fixed at v1; rejecting unknown YAML constructs
// (multi-doc, anchors, tagged scalars) is a feature, not a limitation.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// -------------------- Public types --------------------

export type ArtifactKind = "rule" | "skill" | "memory";
export type Scope = "global" | "repo";

export interface ValidationError {
  code: string;
  message: string;
  // path within the file, e.g. "frontmatter.severity" or "body.section[2]"
  field?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  // Parsed frontmatter (best-effort, even if validation fails).
  parsed?: ParsedFrontmatter;
}

export interface ParsedFrontmatter {
  fields: Record<string, unknown>;
  body: string;
}

export interface CorpusValidationReport {
  ok: boolean;
  rootDir: string;
  filesScanned: number;
  rulesValidated: number;
  skillsValidated: number;
  memoriesValidated: number;
  perFile: { path: string; kind: ArtifactKind; result: ValidationResult }[];
  // Cross-file collisions. Id collision WITHIN a scope is an ERROR;
  // collision ACROSS scopes (global vs repo) is the override mechanism and
  // is reported as INFO via `crossScopeOverrides`.
  duplicateIdsWithinScope: { kind: ArtifactKind; id: string; files: string[] }[];
  crossScopeOverrides: { kind: ArtifactKind; id: string; globalFile: string; repoFile: string }[];
  // Cross-reference warnings (related: points at a non-existent id).
  brokenRelated: { sourceFile: string; relatedId: string }[];
}

// -------------------- Audit schema --------------------

const SUBAGENT_CLASSES = new Set(["main", "agent-tool", "workflow", "background", "cron"]);
const EVENT_TYPES = new Set([
  "retrieve",
  "explain",
  "check",
  "rule_change",
  "agent_apply",
  "missed_retrieval",
  "memory_recorded",
]);
const SCOPE_VALUES = new Set(["global", "repo"]);

export interface AuditEventInput {
  [key: string]: unknown;
}

export function validateAuditEvent(event: AuditEventInput): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  for (const required of [
    "event_type",
    "ts",
    "agent_session_id",
    "parent_agent_session_id",
    "subagent_class",
    "tool_call_id",
    "context_hash",
    "repo_root_detected",
    "scopes_queried",
    "rules_returned",
    "overridden_global_ids",
    "latency_ms",
  ]) {
    if (!(required in event)) {
      errors.push({ code: "AUDIT_MISSING_FIELD", message: `missing ${required}`, field: required });
    }
  }

  const eventType = event.event_type;
  if (typeof eventType !== "string" || !EVENT_TYPES.has(eventType)) {
    errors.push({
      code: "AUDIT_BAD_EVENT_TYPE",
      message: `event_type must be one of ${[...EVENT_TYPES].join(", ")}`,
      field: "event_type",
    });
  }

  const sub = event.subagent_class;
  if (sub !== null && (typeof sub !== "string" || !SUBAGENT_CLASSES.has(sub))) {
    errors.push({
      code: "AUDIT_BAD_SUBAGENT_CLASS",
      message: `subagent_class must be null or one of ${[...SUBAGENT_CLASSES].join(", ")}`,
      field: "subagent_class",
    });
  }

  // The cornerstone rule: any non-"main" subagent class REQUIRES a non-null
  // parent_agent_session_id. Per .betterai/rules/STANDARDS/observability/
  // audit-must-include-parent-session.md.
  if (
    typeof sub === "string" &&
    sub !== "main" &&
    (event.parent_agent_session_id === null || event.parent_agent_session_id === undefined)
  ) {
    errors.push({
      code: "AUDIT_MISSING_PARENT",
      message: `subagent_class=${sub} requires non-null parent_agent_session_id`,
      field: "parent_agent_session_id",
    });
  }

  if (event.scopes_queried !== undefined) {
    if (!Array.isArray(event.scopes_queried)) {
      errors.push({
        code: "AUDIT_SCOPES_NOT_ARRAY",
        message: "scopes_queried must be an array",
        field: "scopes_queried",
      });
    } else {
      for (const s of event.scopes_queried) {
        if (typeof s !== "string" || !SCOPE_VALUES.has(s)) {
          errors.push({
            code: "AUDIT_BAD_SCOPE_VALUE",
            message: `scopes_queried entries must be "global" or "repo"`,
            field: "scopes_queried",
          });
          break;
        }
      }
    }
  }

  if (event.overridden_global_ids !== undefined && !Array.isArray(event.overridden_global_ids)) {
    errors.push({
      code: "AUDIT_OVERRIDES_NOT_ARRAY",
      message: "overridden_global_ids must be an array",
      field: "overridden_global_ids",
    });
  }

  if (event.rules_returned !== undefined && !Array.isArray(event.rules_returned)) {
    errors.push({
      code: "AUDIT_RULES_RETURNED_NOT_ARRAY",
      message: "rules_returned must be an array",
      field: "rules_returned",
    });
  } else if (Array.isArray(event.rules_returned)) {
    for (let i = 0; i < event.rules_returned.length; i++) {
      const r = event.rules_returned[i];
      if (typeof r !== "object" || r === null) {
        errors.push({
          code: "AUDIT_RULE_ITEM_NOT_OBJECT",
          message: `rules_returned[${i}] must be an object`,
          field: `rules_returned[${i}]`,
        });
        continue;
      }
      const rec = r as Record<string, unknown>;
      if (rec.scope !== undefined && (typeof rec.scope !== "string" || !SCOPE_VALUES.has(rec.scope))) {
        errors.push({
          code: "AUDIT_RULE_ITEM_BAD_SCOPE",
          message: `rules_returned[${i}].scope must be "global" or "repo"`,
          field: `rules_returned[${i}].scope`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// -------------------- Frontmatter parser --------------------

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

// Mini-YAML: lines of `key: value`, plus nested mappings (one level deep) and
// flow-style arrays `[a, b, c]` and block-style sequences `- value`.
// Multi-line scalars use the `|` indicator.
export function parseFrontmatter(contents: string): ParsedFrontmatter | null {
  const m = FRONTMATTER_RE.exec(contents);
  if (!m) return null;
  const [, yaml, body] = m;
  const fields = parseMiniYaml(yaml);
  return { fields, body };
}

function parseMiniYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    // top-level key
    const keyMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }
    const [, key, raw] = keyMatch;
    const trimmed = raw.trim();
    if (trimmed === "|") {
      // block scalar — collect indented lines
      i++;
      const collected: string[] = [];
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        collected.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      out[key] = collected.join("\n").replace(/\n+$/, "");
      continue;
    }
    if (trimmed === "" || trimmed === "~" || trimmed === "null") {
      // could be a nested mapping or a sequence below
      const nestedLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith("  ") || lines[j].trim() === "")) {
        nestedLines.push(lines[j]);
        j++;
      }
      if (nestedLines.length === 0) {
        out[key] = trimmed === "" ? null : null;
        i++;
        continue;
      }
      // detect sequence vs mapping
      const firstNonEmpty = nestedLines.find(l => l.trim() !== "");
      if (firstNonEmpty && firstNonEmpty.trim().startsWith("- ")) {
        out[key] = nestedLines
          .filter(l => l.trim().startsWith("- "))
          .map(l => unquote(l.trim().slice(2).trim()));
      } else if (firstNonEmpty) {
        const nested: Record<string, unknown> = {};
        for (const nl of nestedLines) {
          const nm = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(nl);
          if (!nm) continue;
          const [, nk, nv] = nm;
          nested[nk] = parseScalarOrArray(nv);
        }
        out[key] = nested;
      } else {
        out[key] = null;
      }
      i = j;
      continue;
    }
    out[key] = parseScalarOrArray(trimmed);
    i++;
  }
  return out;
}

function parseScalarOrArray(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  // flow array
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map(s => unquote(s.trim()));
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// -------------------- Shared section + frontmatter helpers --------------------

function findH2Sections(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function requireString(
  fields: Record<string, unknown>,
  key: string,
  errors: ValidationError[],
): string | undefined {
  const v = fields[key];
  if (typeof v !== "string" || v.trim() === "") {
    errors.push({
      code: "REQ_MISSING_OR_EMPTY",
      message: `required field ${key} missing or empty`,
      field: `frontmatter.${key}`,
    });
    return undefined;
  }
  return v;
}

const KEBAB_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;

function validateId(id: string | undefined, errors: ValidationError[]): void {
  if (id === undefined) return;
  if (!KEBAB_RE.test(id)) {
    errors.push({
      code: "ID_NOT_KEBAB_CASE",
      message: `id "${id}" must be kebab-case (lowercase letters, digits, hyphens; start with a letter)`,
      field: "frontmatter.id",
    });
  }
}

function validateIsoDate(date: string | undefined, fieldName: string, errors: ValidationError[]): void {
  if (date === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push({
      code: "DATE_NOT_ISO",
      message: `${fieldName} "${date}" must be an ISO date YYYY-MM-DD`,
      field: `frontmatter.${fieldName}`,
    });
  }
}

// -------------------- Rule validator --------------------

const RULE_CATEGORIES = new Set([
  "STANDARDS",
  "PROCESS",
  "PATTERNS",
  "ARCHITECTURE",
  "DOCUMENTATION",
]);
const RULE_SEVERITY = new Set(["low", "medium", "high"]);
const RULE_REQUIRED_SECTIONS = [
  "What this rule says",
  "Why it matters",
  "When this applies",
  "What good looks like",
  "Anti-patterns",
];
const RULE_FORBIDDEN_CHECK_KINDS = new Set(["shell", "ts-module"]);
const RULE_ALLOWED_CHECK_KINDS = new Set(["regex", "ast-grep"]);

export function validateRule(_filepath: string, contents: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fm = parseFrontmatter(contents);
  if (!fm) {
    errors.push({
      code: "NO_FRONTMATTER",
      message: "rule file must begin with a YAML frontmatter block",
    });
    return { ok: false, errors, warnings };
  }
  const f = fm.fields;
  const id = requireString(f, "id", errors);
  validateId(id, errors);
  const title = requireString(f, "title", errors);
  if (title !== undefined && title.length >= 80) {
    warnings.push({
      code: "TITLE_TOO_LONG",
      message: "title should be under 80 characters",
      field: "frontmatter.title",
    });
  }
  if (title !== undefined && title.endsWith(".")) {
    warnings.push({
      code: "TITLE_TRAILING_PERIOD",
      message: "title should not end with a period",
      field: "frontmatter.title",
    });
  }
  const category = requireString(f, "category", errors);
  if (category !== undefined && !RULE_CATEGORIES.has(category)) {
    errors.push({
      code: "CATEGORY_NOT_IN_ENUM",
      message: `category "${category}" not in ${[...RULE_CATEGORIES].join(" | ")}`,
      field: "frontmatter.category",
    });
  }
  requireString(f, "domain", errors);
  const severity = requireString(f, "severity", errors);
  if (severity !== undefined && !RULE_SEVERITY.has(severity)) {
    errors.push({
      code: "SEVERITY_NOT_IN_ENUM",
      message: `severity "${severity}" not in low|medium|high`,
      field: "frontmatter.severity",
    });
  }
  const created = requireString(f, "created", errors);
  validateIsoDate(created, "created", errors);

  // The single most-important rule-schema check: forbid the dropped kinds.
  const check = f.check;
  if (check && typeof check === "object") {
    const kind = (check as Record<string, unknown>).kind;
    if (typeof kind === "string" && RULE_FORBIDDEN_CHECK_KINDS.has(kind)) {
      errors.push({
        code: "CHECK_KIND_FORBIDDEN",
        message: `check.kind="${kind}" is forbidden in v1; only regex and ast-grep are allowed`,
        field: "frontmatter.check.kind",
      });
    } else if (typeof kind === "string" && !RULE_ALLOWED_CHECK_KINDS.has(kind)) {
      errors.push({
        code: "CHECK_KIND_UNKNOWN",
        message: `check.kind="${kind}" is not recognized`,
        field: "frontmatter.check.kind",
      });
    }
  }

  // Body section presence + order.
  const sections = findH2Sections(fm.body);
  let cursor = 0;
  for (const required of RULE_REQUIRED_SECTIONS) {
    const idx = sections.indexOf(required, cursor);
    if (idx === -1) {
      errors.push({
        code: "BODY_MISSING_SECTION",
        message: `body missing required H2 "## ${required}"`,
        field: "body",
      });
    } else {
      cursor = idx + 1;
    }
  }

  return { ok: errors.length === 0, errors, warnings, parsed: fm };
}

// -------------------- Skill validator --------------------

const SKILL_REQUIRED_SECTIONS = [
  "When to use this skill",
  "Prerequisites",
  "Steps",
  "What good looks like",
  "Common failure modes",
  "Related rules",
];

export function validateSkill(_filepath: string, contents: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fm = parseFrontmatter(contents);
  if (!fm) {
    errors.push({ code: "NO_FRONTMATTER", message: "skill file must begin with a YAML frontmatter block" });
    return { ok: false, errors, warnings };
  }
  const f = fm.fields;
  const id = requireString(f, "id", errors);
  validateId(id, errors);
  requireString(f, "title", errors);
  requireString(f, "category", errors);
  requireString(f, "when_to_use", errors);
  const stepsCount = f.steps_count;
  if (typeof stepsCount !== "number" || stepsCount <= 0) {
    errors.push({
      code: "STEPS_COUNT_INVALID",
      message: "steps_count must be a positive number",
      field: "frontmatter.steps_count",
    });
  }
  const created = requireString(f, "created", errors);
  validateIsoDate(created, "created", errors);
  if (f.severity !== undefined) {
    errors.push({
      code: "SKILL_HAS_SEVERITY",
      message: "skills MUST NOT carry a severity field (skills are procedures, not constraints)",
      field: "frontmatter.severity",
    });
  }
  const sections = findH2Sections(fm.body);
  let cursor = 0;
  for (const required of SKILL_REQUIRED_SECTIONS) {
    const idx = sections.indexOf(required, cursor);
    if (idx === -1) {
      errors.push({
        code: "BODY_MISSING_SECTION",
        message: `skill body missing required H2 "## ${required}"`,
        field: "body",
      });
    } else {
      cursor = idx + 1;
    }
  }
  return { ok: errors.length === 0, errors, warnings, parsed: fm };
}

// -------------------- Memory validator --------------------

const MEMORY_KINDS = new Set(["decision", "failure", "discovery", "constraint"]);
const MEMORY_DURABILITY = new Set(["short", "medium", "long"]);
const MEMORY_REQUIRED_SECTIONS = [
  "What happened",
  "Why it matters (for future me)",
  "Don't relitigate",
];

export function validateMemory(filepath: string, contents: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const fm = parseFrontmatter(contents);
  if (!fm) {
    errors.push({ code: "NO_FRONTMATTER", message: "memory file must begin with a YAML frontmatter block" });
    return { ok: false, errors, warnings };
  }
  const f = fm.fields;
  const id = requireString(f, "id", errors);
  validateId(id, errors);
  requireString(f, "title", errors);
  const date = requireString(f, "date", errors);
  validateIsoDate(date, "date", errors);
  requireString(f, "project", errors);
  const kind = requireString(f, "kind", errors);
  if (kind !== undefined && !MEMORY_KINDS.has(kind)) {
    errors.push({
      code: "KIND_NOT_IN_ENUM",
      message: `kind "${kind}" not in decision|failure|discovery|constraint`,
      field: "frontmatter.kind",
    });
  }
  const keywords = f.context_keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    errors.push({
      code: "CONTEXT_KEYWORDS_MISSING",
      message: "context_keywords must be a non-empty array",
      field: "frontmatter.context_keywords",
    });
  }
  const durability = requireString(f, "durability", errors);
  if (durability !== undefined && !MEMORY_DURABILITY.has(durability)) {
    errors.push({
      code: "DURABILITY_NOT_IN_ENUM",
      message: `durability "${durability}" not in short|medium|long`,
      field: "frontmatter.durability",
    });
  }
  if (typeof f.auto_captured !== "boolean") {
    errors.push({
      code: "AUTO_CAPTURED_NOT_BOOL",
      message: "auto_captured must be a boolean",
      field: "frontmatter.auto_captured",
    });
  }
  // Shard correctness: file path must include the yyyy-mm matching the date.
  if (date && /^\d{4}-\d{2}-/.test(date)) {
    const shard = date.slice(0, 7);
    if (!filepath.includes(`/${shard}/`) && !filepath.includes(`\\${shard}\\`)) {
      warnings.push({
        code: "MEMORY_SHARD_MISMATCH",
        message: `memory date ${date} should live under a /${shard}/ shard directory`,
        field: "path",
      });
    }
  }
  // Expired short-durability memory.
  if (
    typeof f.expires_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(f.expires_on) &&
    f.expires_on < new Date().toISOString().slice(0, 10)
  ) {
    warnings.push({
      code: "MEMORY_EXPIRED",
      message: `memory expires_on ${f.expires_on} is in the past — consider pruning`,
      field: "frontmatter.expires_on",
    });
  }
  const sections = findH2Sections(fm.body);
  let cursor = 0;
  for (const required of MEMORY_REQUIRED_SECTIONS) {
    const idx = sections.indexOf(required, cursor);
    if (idx === -1) {
      errors.push({
        code: "BODY_MISSING_SECTION",
        message: `memory body missing required H2 "## ${required}"`,
        field: "body",
      });
    } else {
      cursor = idx + 1;
    }
  }
  return { ok: errors.length === 0, errors, warnings, parsed: fm };
}

// -------------------- Corpus walker --------------------

// rootDir is expected to contain rules/, skills/, memories/ as siblings. The
// walker is tolerant of any subset (it's fine for a brand-new repo corpus to
// have only rules/). We classify each .md file by its containing top-level dir.
export function validateCorpus(rootDir: string): CorpusValidationReport {
  const perFile: CorpusValidationReport["perFile"] = [];
  let rulesValidated = 0;
  let skillsValidated = 0;
  let memoriesValidated = 0;
  const idIndex: Record<ArtifactKind, Map<string, string[]>> = {
    rule: new Map(),
    skill: new Map(),
    memory: new Map(),
  };
  const knownIdsByKind: Record<ArtifactKind, Set<string>> = {
    rule: new Set(),
    skill: new Set(),
    memory: new Set(),
  };
  const allRelatedRefs: { sourceFile: string; relatedId: string }[] = [];
  for (const { kind, files } of walkCorpus(rootDir)) {
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      let result: ValidationResult;
      if (kind === "rule") {
        result = validateRule(file, contents);
        rulesValidated++;
      } else if (kind === "skill") {
        result = validateSkill(file, contents);
        skillsValidated++;
      } else {
        result = validateMemory(file, contents);
        memoriesValidated++;
      }
      perFile.push({ path: file, kind, result });
      const id = result.parsed?.fields?.id;
      if (typeof id === "string") {
        const m = idIndex[kind];
        const arr = m.get(id) ?? [];
        arr.push(file);
        m.set(id, arr);
        knownIdsByKind[kind].add(id);
      }
      const related = result.parsed?.fields?.related;
      if (Array.isArray(related)) {
        for (const r of related) {
          if (typeof r === "string") {
            allRelatedRefs.push({ sourceFile: file, relatedId: r });
          }
        }
      }
    }
  }
  const duplicateIdsWithinScope: CorpusValidationReport["duplicateIdsWithinScope"] = [];
  for (const kind of ["rule", "skill", "memory"] as ArtifactKind[]) {
    for (const [id, files] of idIndex[kind].entries()) {
      if (files.length > 1) {
        duplicateIdsWithinScope.push({ kind, id, files });
      }
    }
  }
  const brokenRelated: CorpusValidationReport["brokenRelated"] = [];
  for (const ref of allRelatedRefs) {
    if (!knownIdsByKind.rule.has(ref.relatedId) && !knownIdsByKind.skill.has(ref.relatedId)) {
      brokenRelated.push(ref);
    }
  }
  const ok =
    perFile.every(p => p.result.ok) &&
    duplicateIdsWithinScope.length === 0;
  return {
    ok,
    rootDir,
    filesScanned: perFile.length,
    rulesValidated,
    skillsValidated,
    memoriesValidated,
    perFile,
    duplicateIdsWithinScope,
    crossScopeOverrides: [],
    brokenRelated,
  };
}

function* walkCorpus(rootDir: string): Generator<{ kind: ArtifactKind; files: string[] }> {
  const kinds: { dir: string; kind: ArtifactKind }[] = [
    { dir: "rules", kind: "rule" },
    { dir: "skills", kind: "skill" },
    { dir: "memories", kind: "memory" },
  ];
  for (const { dir, kind } of kinds) {
    const top = join(rootDir, dir);
    try {
      statSync(top);
    } catch {
      continue;
    }
    yield { kind, files: walkMarkdown(top) };
  }
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith("_")) continue; // skip _meta/
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Re-export helper for tests that want to introspect a parsed corpus path.
export function classifyPath(rootDir: string, filepath: string): ArtifactKind | null {
  const rel = relative(rootDir, filepath);
  if (rel.startsWith("rules/") || rel.startsWith("rules\\")) return "rule";
  if (rel.startsWith("skills/") || rel.startsWith("skills\\")) return "skill";
  if (rel.startsWith("memories/") || rel.startsWith("memories\\")) return "memory";
  return null;
}
