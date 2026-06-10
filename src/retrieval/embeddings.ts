// src/retrieval/embeddings.ts
//
// Phase 1.5 (Wave 6): MiniLM embedding retrieval behind the shared
// `RetrievalScorer` seam (src/contracts/retrieval.ts), plus the hybrid
// scorer that blends grep's exact signals with semantic similarity.
//
// Design constraints (per the corpus STANDARDS rules):
//   - Config from env, resolved by the CALLER (src/app.ts reads
//     BETTERAI_RETRIEVAL_MODE / BETTERAI_MODEL_CACHE_DIR and passes them
//     in).  This module never reads process.env directly.
//   - No magic numbers: every weight/threshold below is a named,
//     documented constant.
//   - Determinism (cache-key safety): embeddings are content-addressed
//     by a sha256 of the embedded text, so for a fixed corpus snapshot
//     and a fixed MatchContext the scores, ordering, and reason strings
//     are identical on every call.
//   - RESILIENCE (M3-style degradation): the hybrid scorer NEVER throws
//     because of the model.  If the embedder fails to load or to embed
//     (offline, missing model cache), it logs ONE structured warning and
//     degrades to grep-only scoring for the rest of the process.
//
// The heavy @xenova/transformers import is LAZY: nothing model-related
// is loaded until the first score call needs an embedding.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Memory, Rule, Skill } from "../corpus/reader.js";
import type {
  MatchContext,
  RetrievalMode,
  RetrievalScorer,
  ScoredArtifact,
} from "../contracts/retrieval.js";
import { GrepScorer } from "./grep.js";
import {
  EMBED_BODY_EXCERPT_CHARS,
  EMBEDDING_MODEL_ID,
  HYBRID_EMBEDDING_WEIGHT,
  HYBRID_SIMILARITY_FLOOR,
} from "../constants/retrieval.js";

// ---- Named constants (no magic numbers) ----------------------------------
//
// The model id, body-excerpt width and hybrid blend weight/floor now live in
// the central constants layer (src/constants/retrieval.ts). They are
// re-exported here so existing importers (tests, callers) keep working.

export {
  EMBEDDING_MODEL_ID,
  HYBRID_EMBEDDING_WEIGHT,
  HYBRID_SIMILARITY_FLOOR,
} from "../constants/retrieval.js";

/** Local alias kept for back-compat with this module's original name. */
export const BODY_EXCERPT_CHARS = EMBED_BODY_EXCERPT_CHARS;

/**
 * Fallback model cache dir when the caller passes none.  The server
 * always passes BETTERAI_MODEL_CACHE_DIR (contracts/env.ts defaults it
 * to the /data/embeddings/models volume in docker); this local fallback
 * covers bare-process use (CLI, opt-in integration test).
 */
export const FALLBACK_MODEL_CACHE_DIR = join(homedir(), ".betterai", "models");

/**
 * Hybrid score formula (documented once, applied to all three kinds):
 *
 *   hybrid = grep_score
 *          + HYBRID_EMBEDDING_WEIGHT
 *            × max(0, (cosine − HYBRID_SIMILARITY_FLOOR) / (1 − HYBRID_SIMILARITY_FLOOR))
 *
 * i.e. similarity is renormalized from [floor, 1] onto [0, 1] and scaled
 * into at most HYBRID_EMBEDDING_WEIGHT points.
 */
export function hybridScore(grepScore: number, cosine: number): number {
  const normalized = Math.max(
    0,
    (cosine - HYBRID_SIMILARITY_FLOOR) / (1 - HYBRID_SIMILARITY_FLOOR),
  );
  return grepScore + HYBRID_EMBEDDING_WEIGHT * normalized;
}

/** Reason token appended when the embedding contributed to a score. */
export const SEMANTIC_REASON = "semantic-match";

// ---- Embedder seam --------------------------------------------------------

/**
 * Batch text → unit-vector embeddings.  Must be deterministic for a
 * given input text (content-addressed caching depends on it).
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** Async factory so model load is lazy AND injectable in tests. */
export type EmbedderFactory = () => Promise<EmbedFn>;

/** Structured log sink (level pre-bound by the caller). */
export type StructuredLog = (
  message: string,
  fields: Record<string, unknown>,
) => void;

export interface EmbedderOptions {
  /** Directory for the MiniLM model files. */
  modelCacheDir?: string;
}

/**
 * The real MiniLM embedder.  Dynamically imports @xenova/transformers on
 * first call so simply constructing a scorer never touches the model.
 * Never downloads in tests: the default suite injects fakes, and the
 * opt-in integration test is gated behind BETTERAI_TEST_EMBEDDINGS=1.
 */
export function miniLmEmbedderFactory(
  opts: EmbedderOptions = {},
): EmbedderFactory {
  return async () => {
    const transformers = await import("@xenova/transformers");
    transformers.env.cacheDir = opts.modelCacheDir ?? FALLBACK_MODEL_CACHE_DIR;
    const pipe = await transformers.pipeline(
      "feature-extraction",
      EMBEDDING_MODEL_ID,
    );
    return async (texts: string[]) => {
      const out: number[][] = [];
      for (const text of texts) {
        const tensor = await pipe(text, { pooling: "mean", normalize: true });
        out.push(Array.from(tensor.data as Float32Array));
      }
      return out;
    };
  };
}

// ---- Text projection + cosine ---------------------------------------------

/** sha256 content hash — the per-artifact embedding cache key. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Artifact text we embed: title + body excerpt. */
export function artifactText(item: {
  title: string;
  body: string;
}): string {
  return `${item.title}\n${item.body.slice(0, BODY_EXCERPT_CHARS)}`;
}

/** Query text we embed: intent + a summary of the touched paths. */
export function queryText(ctx: MatchContext): string {
  return `${ctx.intent}\n${ctx.file_paths.join(" ")}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- EmbeddingScorer --------------------------------------------------------

export interface EmbeddingScorerOptions {
  /** Inject a fake in tests; defaults to the real MiniLM factory. */
  embedderFactory?: EmbedderFactory;
  modelCacheDir?: string;
  /** Debug-level sink for the cold/warm latency hook. */
  debugLog?: StructuredLog;
}

const NOOP_LOG: StructuredLog = () => {};

/**
 * Pure-embedding scorer (mode "embedding").  Scores are the raw cosine
 * similarity clamped to [0, 1] — the orchestrator's capTopK drops ≤ 0.
 *
 * Embeddings are cached per artifact, keyed by contentHash(artifactText):
 * corpus embeddings compute once per process and are reused across calls
 * and across kinds.  (src/cache/context-hash.ts hashes the full
 * retrieval CONTEXT shape — wrong granularity here, so this module keeps
 * its own content-addressed map.)
 */
export class EmbeddingScorer implements RetrievalScorer {
  readonly mode: RetrievalMode = "embedding";

  private readonly factory: EmbedderFactory;
  private readonly debugLog: StructuredLog;
  private embedderPromise: Promise<EmbedFn> | null = null;
  private readonly cache = new Map<string, number[]>();
  private coldDone = false;

  constructor(opts: EmbeddingScorerOptions = {}) {
    this.factory =
      opts.embedderFactory ??
      miniLmEmbedderFactory({ modelCacheDir: opts.modelCacheDir });
    this.debugLog = opts.debugLog ?? NOOP_LOG;
  }

  scoreRules(rules: Rule[], ctx: MatchContext): Promise<ScoredArtifact<Rule>[]> {
    return this.scoreBatch(rules, ctx);
  }

  scoreSkills(
    skills: Skill[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Skill>[]> {
    return this.scoreBatch(skills, ctx);
  }

  scoreMemories(
    memories: Memory[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Memory>[]> {
    return this.scoreBatch(memories, ctx);
  }

  /**
   * Batch cosine similarities for arbitrary artifacts.  Exposed so the
   * HybridScorer reuses the same lazy model + content-addressed cache.
   * THROWS on model failure — resilience policy lives in HybridScorer.
   */
  async similarities(
    items: { title: string; body: string }[],
    ctx: MatchContext,
  ): Promise<number[]> {
    const t0 = Date.now();
    const phase = this.coldDone ? "warm" : "cold";
    const embedder = await this.getEmbedder();

    const query = queryText(ctx);
    const queryKey = contentHash(query);
    const texts = items.map((i) => artifactText(i));
    const keys = texts.map((t) => contentHash(t));

    // Batch every uncached text (query included) into ONE embed call.
    const missing: string[] = [];
    const missingKeys: string[] = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (!this.cache.has(keys[i]) && !missingKeys.includes(keys[i])) {
        missing.push(texts[i]);
        missingKeys.push(keys[i]);
      }
    }
    if (!this.cache.has(queryKey) && !missingKeys.includes(queryKey)) {
      missing.push(query);
      missingKeys.push(queryKey);
    }
    if (missing.length > 0) {
      const vectors = await embedder(missing);
      for (let i = 0; i < missingKeys.length; i += 1) {
        this.cache.set(missingKeys[i], vectors[i]);
      }
    }

    const queryVec = this.cache.get(queryKey)!;
    const sims = keys.map((k) => cosineSimilarity(this.cache.get(k)!, queryVec));

    // Cold/warm latency hook so dogfooding can observe retrieval cost.
    this.coldDone = true;
    this.debugLog("retrieval.embedding.latency", {
      phase,
      latency_ms: Date.now() - t0,
      batch_size: items.length,
      embedded: missing.length,
    });
    return sims;
  }

  private async scoreBatch<T extends { title: string; body: string }>(
    items: T[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<T>[]> {
    if (items.length === 0) return [];
    const sims = await this.similarities(items, ctx);
    return items.map((item, i) => ({
      item,
      score: Math.max(0, sims[i]),
      reason: SEMANTIC_REASON,
    }));
  }

  private getEmbedder(): Promise<EmbedFn> {
    // Lazy, memoized; a rejected load is NOT memoized so a transient
    // failure could recover — the hybrid scorer makes its own once-only
    // degradation decision on top.
    if (!this.embedderPromise) {
      this.embedderPromise = this.factory();
      this.embedderPromise.catch(() => {
        this.embedderPromise = null;
      });
    }
    return this.embedderPromise;
  }
}

// ---- HybridScorer ------------------------------------------------------------

export interface HybridScorerOptions extends EmbeddingScorerOptions {
  /** Warn-level sink for the one-time degradation notice. */
  warnLog?: StructuredLog;
}

/**
 * The default scorer (mode "hybrid", per BETTERAI_RETRIEVAL_MODE).
 *
 * Blends grep + embeddings via `hybridScore()` (see the formula and the
 * named constants above): exact path-glob/severity signals dominate;
 * embedding similarity re-ranks and surfaces semantic matches that grep
 * misses entirely (zero keyword overlap).
 *
 * DEGRADATION: if the embedder fails (load or embed), this scorer emits
 * ONE structured warning for the process and returns pure grep scores —
 * it never throws and never blocks retrieval.
 */
export class HybridScorer implements RetrievalScorer {
  readonly mode: RetrievalMode = "hybrid";

  private readonly grep = new GrepScorer();
  private readonly embedding: EmbeddingScorer;
  private readonly warnLog: StructuredLog;
  private degraded = false;
  private warned = false;

  constructor(opts: HybridScorerOptions = {}) {
    this.embedding = new EmbeddingScorer(opts);
    this.warnLog = opts.warnLog ?? NOOP_LOG;
  }

  async scoreRules(
    rules: Rule[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Rule>[]> {
    return this.blend(await this.grep.scoreRules(rules, ctx), rules, ctx);
  }

  async scoreSkills(
    skills: Skill[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Skill>[]> {
    return this.blend(await this.grep.scoreSkills(skills, ctx), skills, ctx);
  }

  async scoreMemories(
    memories: Memory[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<Memory>[]> {
    return this.blend(await this.grep.scoreMemories(memories, ctx), memories, ctx);
  }

  private async blend<T extends { title: string; body: string }>(
    grepScored: ScoredArtifact<T>[],
    items: T[],
    ctx: MatchContext,
  ): Promise<ScoredArtifact<T>[]> {
    if (items.length === 0 || this.degraded) return grepScored;

    let sims: number[];
    try {
      sims = await this.embedding.similarities(items, ctx);
    } catch (err: unknown) {
      this.degraded = true;
      if (!this.warned) {
        this.warned = true;
        this.warnLog("retrieval.hybrid.degraded_to_grep", {
          mode: this.mode,
          model: EMBEDDING_MODEL_ID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return grepScored;
    }

    return grepScored.map((scored, i) => {
      const score = hybridScore(scored.score, sims[i]);
      const semantic = score > scored.score;
      const reason = semantic
        ? scored.reason === "no-match"
          ? SEMANTIC_REASON
          : `${scored.reason},${SEMANTIC_REASON}`
        : scored.reason;
      return { item: scored.item, score, reason };
    });
  }
}

// ---- Mode selection ------------------------------------------------------------

export interface CreateScorerOptions {
  mode: RetrievalMode;
  modelCacheDir?: string;
  debugLog?: StructuredLog;
  warnLog?: StructuredLog;
  /** Test seam; production callers omit it. */
  embedderFactory?: EmbedderFactory;
}

/**
 * Map BETTERAI_RETRIEVAL_MODE onto a scorer.  The orchestrator and the
 * tool handlers never branch on the mode — this is the single switch.
 */
export function createScorer(opts: CreateScorerOptions): RetrievalScorer {
  switch (opts.mode) {
    case "grep":
      return new GrepScorer();
    case "embedding":
      return new EmbeddingScorer(opts);
    case "hybrid":
      return new HybridScorer(opts);
  }
}
