// src/server/retrieve/grep.ts
//
// Phase 1.0 retrieval is grep-only: match a rule/skill/memory against an
// agent's context via simple substring/glob hits on applies_when fields.
//
// Phase 1.5 (Wave 6): the pure scoring functions below stay exported —
// other call sites and tests use them directly — and `GrepScorer` wraps
// them behind the shared async-batch `RetrievalScorer` seam
// (src/contracts/retrieval.ts) so the orchestrator can swap in the
// MiniLM embedding / hybrid scorers (src/server/retrieve/embeddings.ts)
// without changing.

import type {
  Memory,
  Rule,
  Scope,
  Skill,
} from "../corpus/reader.js";
import type {
  RetrievalMode,
  RetrievalScorer,
} from "../../contracts/retrieval.js";

export interface MatchContext {
  file_paths: string[];
  intent: string;
  symbols: string[];
  recent_diff: string;
}

export interface ScoredArtifact<T> {
  item: T;
  score: number;
  reason: string;
}

const SEVERITY_WEIGHT: Record<Rule["severity"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Score a rule against a context.  Components:
 *   - +3 if any file_path matches an applies_when.paths glob
 *   - +2 if any symbol matches applies_when.symbols
 *   - +2 if any intent keyword matches applies_when.intents
 *   - +1 if the rule body has any literal hit in intent or recent_diff
 *   - × severity weight
 *
 * Returns 0 when nothing matches; the caller filters those out.
 */
export function scoreRule(rule: Rule, ctx: MatchContext): ScoredArtifact<Rule> {
  const reasons: string[] = [];
  let raw = 0;
  const aw = rule.applies_when;
  if (aw?.paths?.length) {
    for (const p of ctx.file_paths) {
      if (aw.paths.some((g) => simpleGlob(g).test(p))) {
        raw += 3;
        reasons.push(`path-match`);
        break;
      }
    }
  }
  if (aw?.symbols?.length) {
    const hit = ctx.symbols.some((s) => aw.symbols!.includes(s));
    if (hit) {
      raw += 2;
      reasons.push("symbol-match");
    }
  }
  if (aw?.intents?.length) {
    const intent = ctx.intent.toLowerCase();
    const hit = aw.intents.some((kw) => intent.includes(kw.toLowerCase()));
    if (hit) {
      raw += 2;
      reasons.push("intent-match");
    }
  }
  if (literalHit(rule.body, ctx)) {
    raw += 1;
    reasons.push("body-text-hit");
  }
  const score = raw * SEVERITY_WEIGHT[rule.severity];
  return { item: rule, score, reason: reasons.join(",") || "no-match" };
}

export function scoreSkill(
  skill: Skill,
  ctx: MatchContext,
): ScoredArtifact<Skill> {
  const reasons: string[] = [];
  let raw = 0;
  const aw = skill.applies_when;
  if (aw?.paths?.length) {
    if (ctx.file_paths.some((p) => aw.paths!.some((g) => simpleGlob(g).test(p)))) {
      raw += 3;
      reasons.push("path-match");
    }
  }
  const intent = ctx.intent.toLowerCase();
  if (aw?.intents?.length) {
    if (aw.intents.some((kw) => intent.includes(kw.toLowerCase()))) {
      raw += 2;
      reasons.push("intent-match");
    }
  }
  if (skill.when_to_use && partialKeywordHit(skill.when_to_use, ctx.intent)) {
    raw += 2;
    reasons.push("when-to-use-hit");
  }
  return { item: skill, score: raw, reason: reasons.join(",") || "no-match" };
}

export function scoreMemory(
  memory: Memory,
  ctx: MatchContext,
): ScoredArtifact<Memory> {
  const reasons: string[] = [];
  let raw = 0;
  const intent = ctx.intent.toLowerCase();
  if (memory.context_keywords?.length) {
    const hit = memory.context_keywords.some((k) => intent.includes(k));
    if (hit) {
      raw += 2;
      reasons.push("keyword-hit");
    }
  }
  if (memory.applies_to_future_intents?.length) {
    const hit = memory.applies_to_future_intents.some((kw) =>
      intent.includes(kw.toLowerCase()),
    );
    if (hit) {
      raw += 2;
      reasons.push("future-intent-hit");
    }
  }
  // Long-durability decisions get a bonus — the corpus's conflict-
  // resolution doc says they outrank rules; let retrieval surface them.
  if (memory.kind === "decision" && memory.durability === "long") raw += 1;
  return { item: memory, score: raw, reason: reasons.join(",") || "no-match" };
}

// ---- RetrievalScorer adapter (Wave 6) -----------------------------------

/**
 * Adapter exposing the synchronous grep scoring functions through the
 * shared async-batch `RetrievalScorer` seam.  Pure delegation — scores,
 * ordering, and reason strings are byte-identical to calling
 * scoreRule/scoreSkill/scoreMemory directly, which keeps the
 * determinism/cache-key contract trivially satisfied.
 */
export class GrepScorer implements RetrievalScorer {
  readonly mode: RetrievalMode = "grep";

  scoreRules(rules: Rule[], ctx: MatchContext): Promise<ScoredArtifact<Rule>[]> {
    return Promise.resolve(rules.map((r) => scoreRule(r, ctx)));
  }

  scoreSkills(
    skills: Skill[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Skill>[]> {
    return Promise.resolve(skills.map((s) => scoreSkill(s, ctx)));
  }

  scoreMemories(
    memories: Memory[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Memory>[]> {
    return Promise.resolve(memories.map((m) => scoreMemory(m, ctx)));
  }
}

// ---- Helpers -----------------------------------------------------------

function simpleGlob(g: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (g[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}?".includes(c)) re += "\\" + c;
    else re += c;
    i += 1;
  }
  return new RegExp(re + "$");
}

function literalHit(body: string, ctx: MatchContext): boolean {
  if (!body) return false;
  const haystack = body.toLowerCase();
  for (const sym of ctx.symbols) {
    if (sym && haystack.includes(sym.toLowerCase())) return true;
  }
  return false;
}

function partialKeywordHit(needleSource: string, intent: string): boolean {
  if (!intent) return false;
  const intentLc = intent.toLowerCase();
  const tokens = needleSource
    .toLowerCase()
    .split(/[^a-z0-9-]+/g)
    .filter((t) => t.length >= 4);
  return tokens.some((t) => intentLc.includes(t));
}

/** Group + cap returned items by domain, per the router config. */
export function capByDomain(
  scored: ScoredArtifact<Rule>[],
  domains: string[],
  maxPerDomain: number,
  maxTotal: number,
): ScoredArtifact<Rule>[] {
  const allowed = new Set(domains);
  const byDomain = new Map<string, ScoredArtifact<Rule>[]>();
  for (const s of scored) {
    if (!allowed.has(s.item.domain)) continue;
    if (s.score <= 0) continue;
    const list = byDomain.get(s.item.domain) ?? [];
    list.push(s);
    byDomain.set(s.item.domain, list);
  }
  const out: ScoredArtifact<Rule>[] = [];
  for (const [, list] of byDomain) {
    list.sort((a, b) => b.score - a.score);
    out.push(...list.slice(0, maxPerDomain));
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxTotal);
}

/** Lighter cap for skills/memories — domain isn't a first-class field. */
export function capTopK<T>(
  scored: ScoredArtifact<T>[],
  topK: number,
): ScoredArtifact<T>[] {
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function scopeFromItem(item: { scope: Scope }): Scope {
  return item.scope;
}
