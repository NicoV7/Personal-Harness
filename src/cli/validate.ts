/**
 * betterai validate
 *
 * Schema-validates the GLOBAL corpus at ~/.betterai/ and (if CWD is in a
 * git repo with a .betterai/ directory) the REPO corpus too.
 *
 * Works WITHOUT the container running. Reads markdown files from disk,
 * parses YAML frontmatter inline, applies the schemas locked in
 * rules/_meta/schema.md.
 *
 * Per .betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectRepoRoot } from "./_shared/repo-root.js";
import { parseFrontmatter } from "./_shared/frontmatter.js";

type Kind = "rule" | "skill" | "memory";
type Scope = "global" | "repo";

interface ValidationError {
  file: string;
  line: number;
  message: string;
  fix: string;
}

const RULE_REQUIRED = ["id", "title", "category", "domain", "severity", "created"];
const RULE_CATEGORIES = new Set(["STANDARDS", "PROCESS", "PATTERNS", "ARCHITECTURE", "DOCUMENTATION"]);
const RULE_SEVERITIES = new Set(["low", "medium", "high"]);

const SKILL_REQUIRED = ["id", "title", "category", "when_to_use", "steps_count", "created"];

const MEMORY_REQUIRED = [
  "id",
  "title",
  "date",
  "project",
  "kind",
  "context_keywords",
  "durability",
  "auto_captured",
];
const MEMORY_KINDS = new Set(["decision", "failure", "discovery", "constraint"]);
const MEMORY_DURABILITIES = new Set(["short", "medium", "long"]);

/**
 * Programmatic validation entry point.
 *
 * Validates the corpus rooted at `rootDir`. Returns 0 on success, 1 on
 * validation errors. Used by tests and downstream tooling that wants to
 * validate a specific corpus root without invoking the CLI.
 *
 * For the CLI-driven flow (scans both global and repo corpora from env +
 * CWD), use {@link runValidate}.
 */
export async function validate(rootDir: string): Promise<number> {
  const errors: ValidationError[] = [];
  const idsByScopeKind = new Map<string, Set<string>>();
  validateRoot(rootDir, "global", errors, idsByScopeKind);
  return errors.length === 0 ? 0 : 1;
}

export function runValidate(_args: string[]): number {
  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const repoRoot = detectRepoRoot(process.cwd());

  const errors: ValidationError[] = [];
  const idsByScopeKind = new Map<string, Set<string>>();

  let globalCount = 0;
  let repoCount = 0;

  if (existsSync(globalRoot)) {
    globalCount = validateRoot(globalRoot, "global", errors, idsByScopeKind);
    process.stdout.write(`[GLOBAL] ${globalRoot}: ${globalCount} artifact(s)\n`);
  } else {
    process.stdout.write(`[GLOBAL] ${globalRoot}: not found (run 'betterai init')\n`);
  }

  if (repoRoot) {
    const repoCorpus = join(repoRoot, ".betterai");
    if (existsSync(repoCorpus)) {
      repoCount = validateRoot(repoCorpus, "repo", errors, idsByScopeKind);
      process.stdout.write(`[REPO]   ${repoCorpus}: ${repoCount} artifact(s)\n`);
    } else {
      process.stdout.write(`[REPO]   ${repoCorpus}: no repo corpus (this is fine)\n`);
    }
  }

  // INFO-level: cross-scope id collisions (override pattern, not an error).
  if (repoCount > 0 && globalCount > 0) {
    for (const kind of ["rule", "skill", "memory"] as Kind[]) {
      const g = idsByScopeKind.get(`global:${kind}`) ?? new Set();
      const r = idsByScopeKind.get(`repo:${kind}`) ?? new Set();
      const collisions = [...r].filter((id) => g.has(id));
      if (collisions.length > 0) {
        process.stdout.write(
          `[INFO]   ${collisions.length} ${kind}(s) override global: ${collisions.join(", ")}\n`,
        );
      }
    }
  }

  if (errors.length === 0) {
    process.stdout.write(`\nOK: ${globalCount + repoCount} artifact(s) validated\n`);
    return 0;
  }

  process.stderr.write(`\n${errors.length} validation error(s):\n\n`);
  for (const e of errors) {
    process.stderr.write(`  ${e.file}:${e.line}\n`);
    process.stderr.write(`    what: ${e.message}\n`);
    process.stderr.write(`    fix:  ${e.fix}\n\n`);
  }
  return 1;
}

function validateRoot(
  root: string,
  scope: Scope,
  errors: ValidationError[],
  idsByScopeKind: Map<string, Set<string>>,
): number {
  let total = 0;
  for (const [kind, subdir] of [["rule", "rules"], ["skill", "skills"], ["memory", "memories"]] as const) {
    const dir = join(root, subdir);
    if (!existsSync(dir)) continue;
    for (const file of walkMarkdown(dir)) {
      total++;
      validateFile(file, kind, scope, errors, idsByScopeKind);
    }
  }
  return total;
}

function validateFile(
  file: string,
  kind: Kind,
  scope: Scope,
  errors: ValidationError[],
  idsByScopeKind: Map<string, Set<string>>,
): void {
  const raw = readFileSync(file, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    errors.push({
      file,
      line: 1,
      message: `frontmatter parse failed: ${parsed.error}`,
      fix: "Ensure file starts with '---' on line 1, then YAML, then '---', then body.",
    });
    return;
  }
  const fm = parsed.frontmatter;

  const required = kind === "rule" ? RULE_REQUIRED : kind === "skill" ? SKILL_REQUIRED : MEMORY_REQUIRED;
  for (const key of required) {
    if (fm[key] === undefined || fm[key] === null || fm[key] === "") {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `missing required ${kind} field '${key}'`,
        fix: `Add '${key}: <value>' to frontmatter. See rules/_meta/schema.md for the ${kind} schema.`,
      });
    }
  }

  if (kind === "rule") {
    if (fm.category && !RULE_CATEGORIES.has(String(fm.category))) {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `category '${fm.category}' is not a valid rule category`,
        fix: `Use one of: ${[...RULE_CATEGORIES].join(", ")}`,
      });
    }
    if (fm.severity && !RULE_SEVERITIES.has(String(fm.severity))) {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `severity '${fm.severity}' is not valid`,
        fix: `Use one of: ${[...RULE_SEVERITIES].join(", ")}`,
      });
    }
  } else if (kind === "memory") {
    if (fm.kind && !MEMORY_KINDS.has(String(fm.kind))) {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `memory kind '${fm.kind}' is not valid`,
        fix: `Use one of: ${[...MEMORY_KINDS].join(", ")}`,
      });
    }
    if (fm.durability && !MEMORY_DURABILITIES.has(String(fm.durability))) {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `durability '${fm.durability}' is not valid`,
        fix: `Use one of: ${[...MEMORY_DURABILITIES].join(", ")}`,
      });
    }
  }

  if (typeof fm.id === "string" && fm.id) {
    const key = `${scope}:${kind}`;
    let set = idsByScopeKind.get(key);
    if (!set) {
      set = new Set();
      idsByScopeKind.set(key, set);
    }
    if (set.has(fm.id)) {
      errors.push({
        file,
        line: parsed.frontmatterEndLine,
        message: `duplicate id '${fm.id}' within ${scope} ${kind}s`,
        fix: `Ids must be unique within a (scope, kind) pair. Rename or merge with the prior file.`,
      });
    } else {
      set.add(fm.id);
    }
  }
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      yield* walkMarkdown(p);
    } else if (entry.endsWith(".md") && !entry.startsWith("_")) {
      yield p;
    }
  }
}
