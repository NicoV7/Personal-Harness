// src/constants/retrieval.ts
//
// Central constants for the retrieval scorers (grep + embeddings/hybrid).
//
// Per no-magic-numbers-import-from-constants: model id, embedding excerpt
// width, hybrid blend weight/floor, the per-signal grep score points and the
// severity weight map are all policy values that belong in ONE named place.

import type { Rule } from "../server/corpus/reader.js";

// ---- Embeddings / hybrid -------------------------------------------------

/** HuggingFace model id baked for Phase 1.5 retrieval. */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/**
 * How much of an artifact body is embedded alongside its title. MiniLM
 * truncates around 256 wordpieces anyway; 512 chars keeps the embedded text
 * focused on the lede where rules/skills state their point.
 */
export const EMBED_BODY_EXCERPT_CHARS = 512;

/**
 * Hybrid blend: maximum points a PERFECT semantic match can add on top of the
 * grep score. Grep's exact signals stay dominant by design.
 */
export const HYBRID_EMBEDDING_WEIGHT = 2;

/**
 * Cosine-similarity floor below which the embedding contributes nothing.
 * MiniLM cosine between unrelated short texts hovers around 0.0–0.3; 0.35
 * keeps random-topic noise from leaking points into every score.
 */
export const HYBRID_SIMILARITY_FLOOR = 0.35;

// ---- Grep scoring --------------------------------------------------------

/** Severity multiplier applied to a rule's raw grep score. */
export const SEVERITY_WEIGHT: Record<Rule["severity"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Points for a file_path → applies_when.paths glob hit. */
export const SCORE_PATH_MATCH = 3;
/** Points for a symbol → applies_when.symbols hit. */
export const SCORE_SYMBOL_MATCH = 2;
/** Points for an intent-keyword → applies_when.intents hit. */
export const SCORE_INTENT_MATCH = 2;
/** Points for a literal body-text hit in intent/recent_diff. */
export const SCORE_BODY_HIT = 1;
