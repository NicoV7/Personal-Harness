// src/__tests__/embeddings.test.ts
//
// Wave 6 — MiniLM hybrid retrieval behind the RetrievalScorer seam.
//
// The DEFAULT suite is offline-deterministic: every test injects a FAKE
// embedder (a tiny concept-bag vectorizer) and never touches the network
// or the model cache.  The one real-MiniLM integration test is opt-in
// behind BETTERAI_TEST_EMBEDDINGS=1 (it.skipIf), per the corpus testing
// standards (deterministic, no external state).

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Memory, Rule, Skill } from "../corpus/reader.js";
import type { MatchContext } from "../contracts/retrieval.js";
import {
  GrepScorer,
  scoreMemory,
  scoreRule,
  scoreSkill,
} from "../retrieval/grep.js";
import {
  EmbeddingScorer,
  HybridScorer,
  HYBRID_EMBEDDING_WEIGHT,
  HYBRID_SIMILARITY_FLOOR,
  SEMANTIC_REASON,
  artifactText,
  contentHash,
  cosineSimilarity,
  createScorer,
  hybridScore,
  queryText,
  type EmbedFn,
} from "../retrieval/embeddings.js";

// ---- Fixtures ---------------------------------------------------------------

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: "rule.fixture",
    title: "Fixture rule",
    category: "STANDARDS",
    domain: "testing",
    severity: "medium",
    created: "2026-01-01",
    scope: "global",
    source_path: "/tmp/fixture.md",
    body: "Fixture body.",
    ...over,
  };
}

function makeSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill.fixture",
    title: "Fixture skill",
    category: "testing",
    when_to_use: "Whenever the fixture asks.",
    steps_count: 1,
    created: "2026-01-01",
    scope: "global",
    source_path: "/tmp/fixture-skill.md",
    body: "Fixture skill body.",
    ...over,
  };
}

function makeMemory(over: Partial<Memory> = {}): Memory {
  return {
    id: "memory.fixture",
    title: "Fixture memory",
    date: "2026-01-01",
    project: "betterai",
    kind: "decision",
    context_keywords: [],
    durability: "medium",
    auto_captured: false,
    scope: "global",
    source_path: "/tmp/fixture-memory.md",
    body: "Fixture memory body.",
    ...over,
  };
}

const ctxOf = (over: Partial<MatchContext>): MatchContext => ({
  file_paths: [],
  intent: "",
  symbols: [],
  recent_diff: "",
  ...over,
});

// ---- The fake embedder ---------------------------------------------------------
//
// A deterministic concept-bag vectorizer: each known concept owns one
// dimension; a text's vector is 1 in every dimension whose synonyms
// appear in it.  This lets us build a SEMANTIC match with ZERO keyword
// overlap: "sign-in" and "authentication" share a concept but no token.

const CONCEPTS: string[][] = [
  ["authentication", "sign-in", "login credentials"], // dim 0
  ["database", "postgres"], // dim 1
  ["caching", "memoization"], // dim 2
];

function conceptEmbed(): { embed: EmbedFn; calls: () => number; texts: string[] } {
  let calls = 0;
  const seen: string[] = [];
  const embed: EmbedFn = (texts) => {
    calls += 1;
    seen.push(...texts);
    return Promise.resolve(
      texts.map((text) => {
        const lc = text.toLowerCase();
        return CONCEPTS.map((syns) =>
          syns.some((s) => lc.includes(s)) ? 1 : 0,
        );
      }),
    );
  };
  return { embed, calls: () => calls, texts: seen };
}

// ---- GrepScorer adapter parity --------------------------------------------------

describe("GrepScorer (RetrievalScorer adapter)", () => {
  it("returns exactly the pure-function scores, reasons, and order", async () => {
    const scorer = new GrepScorer();
    const ctx = ctxOf({
      intent: "add login validation",
      file_paths: ["src/auth/login.ts"],
      symbols: ["validateToken"],
    });
    const rules = [
      makeRule({
        id: "r.path",
        applies_when: { paths: ["src/auth/**"] },
        severity: "high",
      }),
      makeRule({ id: "r.none" }),
    ];
    const skills = [makeSkill({ when_to_use: "when adding login flows" })];
    const memories = [makeMemory({ context_keywords: ["login"] })];

    expect(scorer.mode).toBe("grep");
    expect(await scorer.scoreRules(rules, ctx)).toEqual(
      rules.map((r) => scoreRule(r, ctx)),
    );
    expect(await scorer.scoreSkills(skills, ctx)).toEqual(
      skills.map((s) => scoreSkill(s, ctx)),
    );
    expect(await scorer.scoreMemories(memories, ctx)).toEqual(
      memories.map((m) => scoreMemory(m, ctx)),
    );
  });
});

// ---- EmbeddingScorer -------------------------------------------------------------

describe("EmbeddingScorer (fake embedder)", () => {
  const semanticCtx = ctxOf({ intent: "harden the sign-in flow" });

  it("scores by cosine similarity and lazily loads the embedder once", async () => {
    const fake = conceptEmbed();
    let factoryCalls = 0;
    const scorer = new EmbeddingScorer({
      embedderFactory: () => {
        factoryCalls += 1;
        return Promise.resolve(fake.embed);
      },
    });
    expect(factoryCalls).toBe(0); // LAZY: nothing loads at construction

    const rules = [
      makeRule({ id: "r.auth", body: "Always validate authentication tokens." }),
      makeRule({ id: "r.db", body: "Use postgres transactions." }),
    ];
    const scored = await scorer.scoreRules(rules, semanticCtx);
    expect(factoryCalls).toBe(1);
    expect(scorer.mode).toBe("embedding");
    expect(scored[0].score).toBeGreaterThan(0); // sign-in ~ authentication
    expect(scored[0].reason).toBe(SEMANTIC_REASON);
    expect(scored[1].score).toBe(0); // unrelated concept
  });

  it("caches artifact embeddings by content hash across calls", async () => {
    const fake = conceptEmbed();
    const scorer = new EmbeddingScorer({
      embedderFactory: () => Promise.resolve(fake.embed),
    });
    const rules = [makeRule({ id: "r.auth", body: "authentication" })];

    await scorer.scoreRules(rules, semanticCtx);
    const textsAfterFirst = fake.texts.length; // query + 1 artifact
    expect(textsAfterFirst).toBe(2);

    // Same corpus + same ctx again: everything content-addressed → zero
    // new texts embedded.
    await scorer.scoreRules(rules, semanticCtx);
    expect(fake.texts.length).toBe(textsAfterFirst);

    // New ctx: only the QUERY is re-embedded; corpus embeddings reused.
    await scorer.scoreRules(rules, ctxOf({ intent: "tune caching layer" }));
    expect(fake.texts.length).toBe(textsAfterFirst + 1);
  });

  it("hash + projection helpers are stable", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    const rule = makeRule({ title: "T", body: "B".repeat(2000) });
    expect(artifactText(rule).length).toBeLessThanOrEqual(2 + 512);
    expect(
      queryText(ctxOf({ intent: "x", file_paths: ["a.ts", "b.ts"] })),
    ).toBe("x\na.ts b.ts");
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // zero-vector guard
  });
});

// ---- HybridScorer ------------------------------------------------------------------

describe("HybridScorer", () => {
  const semanticCtx = ctxOf({ intent: "harden the sign-in flow" });

  it("surfaces a semantic match grep misses entirely (zero keyword overlap)", async () => {
    const fake = conceptEmbed();
    const scorer = new HybridScorer({
      embedderFactory: () => Promise.resolve(fake.embed),
    });
    // No applies_when, no symbol/body keyword overlap with the intent —
    // grep scores 0 — but "authentication" and "sign-in" share a concept.
    const rule = makeRule({
      id: "r.semantic",
      title: "Authentication tokens must be validated",
      body: "Validate authentication tokens on every request.",
    });
    expect(scoreRule(rule, semanticCtx).score).toBe(0); // grep miss proven

    const [scored] = await scorer.scoreRules([rule], semanticCtx);
    expect(scorer.mode).toBe("hybrid");
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.score).toBeLessThanOrEqual(HYBRID_EMBEDDING_WEIGHT);
    expect(scored.reason).toBe(SEMANTIC_REASON);
  });

  it("keeps exact grep signals dominant and documents the formula", async () => {
    const fake = conceptEmbed();
    const scorer = new HybridScorer({
      embedderFactory: () => Promise.resolve(fake.embed),
    });
    const ctx = ctxOf({
      intent: "harden the sign-in flow",
      file_paths: ["src/auth/login.ts"],
    });
    const exactHit = makeRule({
      id: "r.exact",
      applies_when: { paths: ["src/auth/**"] },
      severity: "high",
      title: "Authentication rule",
      body: "authentication",
    });
    const semanticOnly = makeRule({
      id: "r.semantic",
      title: "Authentication tokens",
      body: "authentication",
    });

    const scored = await scorer.scoreRules([exactHit, semanticOnly], ctx);
    const grepExact = scoreRule(exactHit, ctx).score; // 3 × high(3) = 9
    expect(scored[0].score).toBe(hybridScore(grepExact, 1));
    expect(scored[0].reason).toContain("path-match");
    expect(scored[0].reason).toContain(SEMANTIC_REASON);
    // A perfect semantic-only match can add at most the embedding weight
    // — it can never outrank the exact path/severity hit.
    expect(scored[1].score).toBeLessThan(scored[0].score);
    expect(scored[1].score).toBe(
      hybridScore(0, 1), // = HYBRID_EMBEDDING_WEIGHT × (1 − floor)/(1 − floor)
    );
    // Below-floor similarity contributes nothing.
    expect(hybridScore(5, HYBRID_SIMILARITY_FLOOR)).toBe(5);
    expect(hybridScore(5, 0)).toBe(5);
  });

  it("degrades to grep-only when the embedder factory throws, warning exactly once", async () => {
    const warnings: { msg: string; fields: Record<string, unknown> }[] = [];
    const scorer = new HybridScorer({
      embedderFactory: () => Promise.reject(new Error("model cache missing")),
      warnLog: (msg, fields) => warnings.push({ msg, fields }),
    });
    const ctx = ctxOf({
      intent: "add login validation",
      file_paths: ["src/auth/login.ts"],
    });
    const rules = [
      makeRule({ id: "r.path", applies_when: { paths: ["src/auth/**"] } }),
      makeRule({ id: "r.none" }),
    ];

    // Never throws; returns exactly the grep scores.
    const first = await scorer.scoreRules(rules, ctx);
    expect(first).toEqual(rules.map((r) => scoreRule(r, ctx)));

    // Repeat calls (and other kinds) stay grep-only with NO new warning.
    await scorer.scoreRules(rules, ctx);
    await scorer.scoreSkills([makeSkill()], ctx);
    await scorer.scoreMemories([makeMemory()], ctx);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg).toBe("retrieval.hybrid.degraded_to_grep");
    expect(warnings[0].fields.error).toBe("model cache missing");
  });

  it("degrades the same way when embedding ITSELF throws mid-flight", async () => {
    const warnings: string[] = [];
    const scorer = new HybridScorer({
      embedderFactory: () =>
        Promise.resolve(() => Promise.reject(new Error("inference failed"))),
      warnLog: (msg) => warnings.push(msg),
    });
    const ctx = ctxOf({ intent: "anything" });
    const out = await scorer.scoreRules([makeRule()], ctx);
    expect(out).toEqual([scoreRule(makeRule(), ctx)]);
    expect(warnings).toHaveLength(1);
  });

  it("is deterministic: same corpus + ctx scored twice gives identical results", async () => {
    const fake = conceptEmbed();
    const scorer = new HybridScorer({
      embedderFactory: () => Promise.resolve(fake.embed),
    });
    const ctx = ctxOf({
      intent: "harden the sign-in flow",
      file_paths: ["src/auth/login.ts"],
    });
    const rules = [
      makeRule({ id: "r.a", title: "Authentication", body: "authentication" }),
      makeRule({ id: "r.b", applies_when: { paths: ["src/auth/**"] } }),
      makeRule({ id: "r.c", body: "postgres" }),
    ];
    const skills = [makeSkill({ title: "Login credentials rotation" })];
    const memories = [makeMemory({ body: "memoization decision" })];

    const first = {
      rules: await scorer.scoreRules(rules, ctx),
      skills: await scorer.scoreSkills(skills, ctx),
      memories: await scorer.scoreMemories(memories, ctx),
    };
    const second = {
      rules: await scorer.scoreRules(rules, ctx),
      skills: await scorer.scoreSkills(skills, ctx),
      memories: await scorer.scoreMemories(memories, ctx),
    };
    // Identical scores, ordering, AND reason strings (cache-key safety
    // per the RetrievalScorer determinism contract).
    expect(second).toEqual(first);
  });
});

// ---- Mode selection ------------------------------------------------------------------

describe("createScorer (BETTERAI_RETRIEVAL_MODE)", () => {
  it("maps each mode onto the matching scorer", () => {
    expect(createScorer({ mode: "grep" }).mode).toBe("grep");
    expect(createScorer({ mode: "embedding" }).mode).toBe("embedding");
    expect(createScorer({ mode: "hybrid" }).mode).toBe("hybrid");
    expect(createScorer({ mode: "grep" })).toBeInstanceOf(GrepScorer);
    expect(createScorer({ mode: "embedding" })).toBeInstanceOf(EmbeddingScorer);
    expect(createScorer({ mode: "hybrid" })).toBeInstanceOf(HybridScorer);
  });

  it("grep mode preserves Phase 1.0 scoring exactly (suite-behavior guard)", async () => {
    const scorer = createScorer({ mode: "grep" });
    const ctx = ctxOf({
      intent: "add login validation tests",
      file_paths: ["src/auth/login.ts"],
      symbols: ["validateToken"],
    });
    const rules = [
      makeRule({
        id: "r.full",
        applies_when: {
          paths: ["src/auth/**"],
          symbols: ["validateToken"],
          intents: ["login"],
        },
        severity: "high",
        body: "uses validateToken internally",
      }),
      makeRule({ id: "r.miss" }),
    ];
    expect(await scorer.scoreRules(rules, ctx)).toEqual(
      rules.map((r) => scoreRule(r, ctx)),
    );
  });
});

// ---- Latency hook -----------------------------------------------------------------

describe("latency debug hook", () => {
  it("logs cold on the first embed and warm afterwards", async () => {
    const fake = conceptEmbed();
    const events: Record<string, unknown>[] = [];
    const scorer = new EmbeddingScorer({
      embedderFactory: () => Promise.resolve(fake.embed),
      debugLog: (msg, fields) => events.push({ msg, ...fields }),
    });
    const ctx = ctxOf({ intent: "harden the sign-in flow" });
    await scorer.scoreRules([makeRule()], ctx);
    await scorer.scoreRules([makeRule()], ctx);
    expect(events).toHaveLength(2);
    expect(events[0].msg).toBe("retrieval.embedding.latency");
    expect(events[0].phase).toBe("cold");
    expect(events[1].phase).toBe("warm");
    expect(typeof events[0].latency_ms).toBe("number");
  });
});

// ---- Opt-in real-model integration -------------------------------------------------
//
// Loads the actual MiniLM weights. NEVER runs in the default suite — set
// BETTERAI_TEST_EMBEDDINGS=1 (and have network or a primed cache dir) to
// exercise it: BETTERAI_TEST_EMBEDDINGS=1 npx vitest run embeddings.

const realModelOptIn = process.env.BETTERAI_TEST_EMBEDDINGS === "1";

describe("MiniLM integration (opt-in)", () => {
  it.skipIf(!realModelOptIn)(
    "real model ranks the semantically related rule above the unrelated one",
    async () => {
      const cacheDir =
        process.env.BETTERAI_MODEL_CACHE_DIR ??
        mkdtempSync(join(tmpdir(), "betterai-models-"));
      const scorer = new EmbeddingScorer({ modelCacheDir: cacheDir });
      const ctx = ctxOf({ intent: "validate user login sessions" });
      const related = makeRule({
        id: "r.related",
        title: "Authentication sessions",
        body: "Sessions must be re-authenticated after expiry.",
      });
      const unrelated = makeRule({
        id: "r.unrelated",
        title: "CSS grid layout",
        body: "Prefer grid-template-areas for page layout.",
      });
      const scored = await scorer.scoreRules([related, unrelated], ctx);
      expect(scored[0].score).toBeGreaterThan(scored[1].score);
    },
    120_000,
  );
});
