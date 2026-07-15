"""HybridQuery retrieval: one query per aspect, threshold + keyword selection.

Selection rule (user-specified): keep hits whose cosine similarity meets
BETTERAI_SIMILARITY_THRESHOLD AND that have a keyword match. top_k is an
OPTIONAL cap — the threshold decides what comes back, so the agent can
read every genuinely relevant skill in full.

Multi-part tasks: the caller passes `aspects` (one string per
sub-problem, e.g. "networking error handling", "write feature tests");
each aspect runs its own HybridQuery so phase-specific skills are not
averaged away inside one long-plan embedding. Results are unioned by id,
keeping the best score.

DEFERRED SEAM: the agentic retrieval loop plugs in after this stage and
must bypass any response cache (determinism carve-out).
"""

from __future__ import annotations

import re

import redis.exceptions
from redisvl.index import SearchIndex
from redisvl.query import HybridQuery
from redisvl.query.filter import FilterExpression, Tag
from redisvl.utils.vectorize import OpenAITextVectorizer

from app.errors import Errors
from app.settings import Settings

RETURN_FIELDS = (
    "id",
    "artifact_type",
    "domain",
    "category",
    "title",
    "when_to_use",
    "keywords",
)
SCORE_FIELDS = {
    "yield_text_score_as": "text_score",
    "yield_vsim_score_as": "vector_similarity",
    "yield_combined_score_as": "hybrid_score",
}
_TOKEN = re.compile(r"[a-z0-9]{3,}")


def search(
    prompt: str,
    *,
    vectorizer: OpenAITextVectorizer,
    index: SearchIndex,
    settings: Settings,
    aspects: list[str] | None = None,
    domain: str | None = None,
    artifact_type: str | None = None,
    top_k: int | None = None,
) -> list[dict]:
    """Prompt (+ per-subproblem aspects) in, filtered hit dicts out."""
    queries = _query_texts(prompt, aspects)
    vectors = _embed(vectorizer, queries)
    kept: dict[str, dict] = {}
    for query_text, vector in zip(queries, vectors):
        hits = _run_hybrid(query_text, vector, index=index, settings=settings,
                           domain=domain, artifact_type=artifact_type)
        if hits and all(hit.get("vector_similarity") is None for hit in hits):
            raise Errors.query_error(
                "hybrid results carry no vector_similarity field; cannot apply the threshold"
            )
        for hit in hits:
            # RRF unions both legs: a hit the vector leg never scored has no
            # vector_similarity and cannot meet the cosine AND keyword rule.
            if hit.get("vector_similarity") is None:
                continue
            if similarity(hit) < settings.similarity_threshold:
                continue
            if not keyword_hit(hit, query_text):
                continue
            _keep_best(kept, hit)
    ranked = sorted(kept.values(), key=hit_score, reverse=True)
    return ranked[:top_k] if top_k else ranked


def _query_texts(prompt: str, aspects: list[str] | None) -> list[str]:
    texts = [prompt, *(aspects or [])]
    deduped = list(dict.fromkeys(text.strip() for text in texts if text and text.strip()))
    if not deduped:
        raise Errors.query_error("query_skills needs a prompt or at least one aspect")
    return deduped


def _embed(vectorizer: OpenAITextVectorizer, texts: list[str]) -> list[list[float]]:
    try:
        return vectorizer.embed_many(texts)
    except Exception as exc:  # re-raised typed: provider failure must say so
        raise Errors.embedding_provider(str(exc)) from exc


def _run_hybrid(
    query_text: str,
    vector: list[float],
    *,
    index: SearchIndex,
    settings: Settings,
    domain: str | None,
    artifact_type: str | None,
) -> list[dict]:
    kwargs: dict = {
        "text": query_text,
        "text_field_name": "body",
        "vector": vector,
        "vector_field_name": "embedding",
        "combination_method": settings.hybrid_fusion.upper(),
        "num_results": settings.max_candidates,
        "return_fields": list(RETURN_FIELDS),
        **SCORE_FIELDS,
    }
    if settings.hybrid_fusion == "linear":
        kwargs["linear_alpha"] = settings.hybrid_alpha
    facet_filter = _facet_filter(domain, artifact_type)
    if facet_filter is not None:
        kwargs["filter_expression"] = facet_filter
    try:
        return list(index.query(HybridQuery(**kwargs)))
    except redis.exceptions.ConnectionError as exc:
        raise Errors.stack_unavailable("redis", str(exc)) from exc
    except redis.exceptions.RedisError as exc:
        raise Errors.query_error(str(exc), cause=exc) from exc


def _facet_filter(domain: str | None, artifact_type: str | None) -> FilterExpression | None:
    expressions = []
    if domain:
        expressions.append(Tag("domain") == domain)
    if artifact_type:
        expressions.append(Tag("artifact_type") == artifact_type)
    if not expressions:
        return None
    combined = expressions[0]
    for expression in expressions[1:]:
        combined = combined & expression
    return combined


def similarity(hit: dict) -> float:
    """Cosine similarity from the explicitly yielded field; absence is a
    loud error — the threshold rule cannot be applied blind."""
    raw = hit.get("vector_similarity")
    if raw is not None:
        return float(raw)
    raise Errors.query_error(
        "hybrid results carry no vector_similarity field; cannot apply the threshold"
    )


def keyword_hit(hit: dict, query_text: str) -> bool:
    score = hit.get("text_score")
    if score is not None:
        return float(score) > 0.0
    tokens = set(_TOKEN.findall(query_text.lower()))
    haystack = " ".join(
        str(hit.get(field) or "")
        for field in ("title", "keywords", "when_to_use", "domain", "category")
    ).lower()
    return any(token in haystack for token in tokens)


def hit_score(hit: dict) -> float:
    raw = hit.get("hybrid_score")
    return float(raw) if raw is not None else similarity(hit)


def _keep_best(kept: dict[str, dict], hit: dict) -> None:
    hit_id = str(hit.get("id"))
    current = kept.get(hit_id)
    if current is None or hit_score(hit) > hit_score(current):
        kept[hit_id] = hit
