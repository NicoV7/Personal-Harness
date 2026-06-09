/**
 * betterai why <task-description> [--context <path>]
 *
 * Per DX-FIX-11: simulate a retrieve_context call against a hand-given
 * context and explain the routing decision step-by-step. This is the
 * "why didn't retrieval fire?" debugging command.
 *
 * Works offline. We read all artifacts from disk, run a tiny in-process
 * router (path-glob + grep + recency), and print the decision trail.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectRepoRoot } from "./_shared/repo-root.js";
import { parseFrontmatter } from "./_shared/frontmatter.js";

interface Candidate {
  id: string;
  kind: "rule" | "skill" | "memory";
  scope: "global" | "repo";
  file: string;
  domain: string;
  severity: "low" | "medium" | "high" | "n/a";
  matchScore: number;
  matchReasons: string[];
}

export function runWhy(args: string[]): number {
  // Parse args: first positional is the task description; --context <path> overrides.
  let task = "";
  let contextPath = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--context") {
      contextPath = args[++i] ?? "";
    } else if (a.startsWith("--")) {
      // Unknown flag — surface but don't crash. Helps the user spot typos.
      process.stderr.write(`why: ignoring unknown flag '${a}'\n`);
    } else {
      task = task ? `${task} ${a}` : a;
    }
  }
  if (!task) {
    process.stderr.write(`why: missing task description\n  usage: betterai why "<task>" [--context <path>]\n`);
    return 2;
  }

  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const repoRoot = detectRepoRoot(process.cwd());

  process.stdout.write(`\nbetterai why "${task}"\n`);
  process.stdout.write(`${"─".repeat(60)}\n`);
  process.stdout.write(`Context paths: ${contextPath || "(none — using task text only)"}\n`);
  process.stdout.write(`Global corpus: ${globalRoot}\n`);
  process.stdout.write(`Repo corpus:   ${repoRoot ? join(repoRoot, ".betterai") : "(no repo detected)"}\n\n`);

  // Step 1: gather all candidate artifacts from both corpora.
  process.stdout.write(`(1) Loading candidates from both corpora…\n`);
  const candidates: Candidate[] = [];
  if (existsSync(globalRoot)) {
    loadArtifacts(globalRoot, "global", candidates);
  }
  if (repoRoot && existsSync(join(repoRoot, ".betterai"))) {
    loadArtifacts(join(repoRoot, ".betterai"), "repo", candidates);
  }
  process.stdout.write(`    -> ${candidates.length} candidate artifact(s) loaded\n\n`);

  // Step 2: domain-router by path-glob (if context paths) and keyword match against task.
  process.stdout.write(`(2) Domain routing (path glob + task keywords)\n`);
  const taskKeywords = tokenize(task);
  const contextPaths = contextPath ? [contextPath] : [];
  for (const c of candidates) {
    scoreCandidate(c, taskKeywords, contextPaths);
  }
  const matched = candidates.filter((c) => c.matchScore > 0);
  process.stdout.write(`    -> ${matched.length} of ${candidates.length} matched (score > 0)\n\n`);

  // Step 3: ranking — severity (rules only) × match × recency.
  process.stdout.write(`(3) Ranking by severity × match × recency\n`);
  matched.sort((a, b) => finalScore(b) - finalScore(a));

  // Step 4: id-collision override (repo wins).
  process.stdout.write(`(4) Applying repo-over-global id collisions\n`);
  const overridden: string[] = [];
  const repoIds = new Set(matched.filter((c) => c.scope === "repo").map((c) => `${c.kind}:${c.id}`));
  const final = matched.filter((c) => {
    if (c.scope === "global" && repoIds.has(`${c.kind}:${c.id}`)) {
      overridden.push(c.id);
      return false;
    }
    return true;
  });
  if (overridden.length > 0) {
    process.stdout.write(`    -> repo overrides: ${overridden.join(", ")}\n`);
  } else {
    process.stdout.write(`    -> no overrides\n`);
  }

  // Output the top results.
  process.stdout.write(`\n${"─".repeat(60)}\nTop matches:\n\n`);
  const top = final.slice(0, 10);
  if (top.length === 0) {
    process.stdout.write(`  (none — nothing in the corpus matched this task)\n`);
    process.stdout.write(`  Try: rephrase the task, or check that you have seeded the corpus\n`);
    process.stdout.write(`       with 'betterai init --seed'.\n`);
    return 0;
  }
  for (const c of top) {
    process.stdout.write(
      `  [${c.scope.toUpperCase()}] ${c.kind} ${c.id}\n` +
        `    domain=${c.domain} severity=${c.severity} score=${finalScore(c).toFixed(3)}\n` +
        `    reasons: ${c.matchReasons.join("; ")}\n` +
        `    file: ${c.file}\n\n`,
    );
  }
  return 0;
}

function loadArtifacts(root: string, scope: "global" | "repo", out: Candidate[]): void {
  for (const [kind, sub] of [["rule", "rules"], ["skill", "skills"], ["memory", "memories"]] as const) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const file of walkMarkdown(dir)) {
      try {
        const raw = readFileSync(file, "utf8");
        const parsed = parseFrontmatter(raw);
        if (!parsed.ok) continue;
        const fm = parsed.frontmatter;
        out.push({
          id: String(fm.id ?? ""),
          kind,
          scope,
          file,
          domain: String(fm.domain ?? fm.category ?? ""),
          severity: (fm.severity as Candidate["severity"]) ?? "n/a",
          matchScore: 0,
          matchReasons: [],
        });
      } catch {
        // Skip unparseable files. `betterai validate` is the right place to report these.
      }
    }
  }
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkMarkdown(p);
    else if (entry.endsWith(".md") && !entry.startsWith("_")) yield p;
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function scoreCandidate(c: Candidate, taskKeywords: string[], contextPaths: string[]): void {
  // Match on id, domain, and any path glob hits (light approximation).
  const idTokens = tokenize(c.id);
  const domainTokens = tokenize(c.domain);
  let hits = 0;
  for (const k of taskKeywords) {
    if (idTokens.includes(k)) {
      hits++;
      c.matchReasons.push(`id contains '${k}'`);
    }
    if (domainTokens.includes(k)) {
      hits++;
      c.matchReasons.push(`domain matches '${k}'`);
    }
  }
  for (const p of contextPaths) {
    const lower = p.toLowerCase();
    for (const k of [...idTokens, ...domainTokens]) {
      if (lower.includes(k)) {
        hits++;
        c.matchReasons.push(`context path mentions '${k}'`);
        break;
      }
    }
  }
  c.matchScore = hits;
}

function finalScore(c: Candidate): number {
  const sev = c.severity === "high" ? 1.0 : c.severity === "medium" ? 0.66 : c.severity === "low" ? 0.33 : 0.5;
  // Rules outrank skills which outrank memories at equal match score —
  // mirrors the conflict-resolution priority for the "show me what would fire" view.
  const kindWeight = c.kind === "rule" ? 1.0 : c.kind === "skill" ? 0.8 : 0.6;
  return sev * kindWeight * c.matchScore;
}
