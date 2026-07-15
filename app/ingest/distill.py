"""Distillation: one structured chat call per chunk -> corpus artifacts.

One attempt per chunk, fail loud on malformed output (fail-loud-no-
retries): a distiller that silently drops chunks would rot the corpus
without anyone noticing. Non-normative chunks (intros, asides) are the
one sanctioned skip, and the model must say so explicitly via the
{"skip": true} sentinel.
"""

from __future__ import annotations

import json
import re
from typing import Any

from openai import OpenAI, OpenAIError
from pydantic import ValidationError

from app.corpus.schema import REQUIRED_RULE_SECTIONS
from app.corpus.writer import AppliesWhenInput, ArtifactInput
from app.errors import Errors
from app.ingest.chunk import Chunk
from app.settings import Settings

_SLUG = re.compile(r"[^a-z0-9]+")

DISTILL_SYSTEM_PROMPT = f"""You distill engineering blog prose into corpus artifacts for a \
coding-agent harness. Given one chunk of a post, extract EVERY distinct, actionable \
prescription as its own artifact. Reply with JSON only:

{{"skip": true}} — ONLY if the chunk contains no actionable engineering guidance \
(author chatter, subscription footers, empty section stubs).

Otherwise:
{{"artifacts": [{{
  "id": "kebab-case-id",            // short, imperative, unique, e.g. "no-retry-storms"
  "artifact_type": "rule" | "skill", // rule = constraint (DO/DON'T); skill = procedure (HOW, step by step)
  "title": "one-line imperative",
  "severity": "low" | "medium" | "high",  // rules only: high = violating it ships defects/breaches
  "forced": true | false,           // true ONLY for rules that apply to nearly EVERY coding task regardless of domain; at most 1-2 per whole post; when unsure, false
  "when_to_use": "one sentence: the coding situation where this applies",
  "intents": ["5-10 short keyword phrases a coding agent would match on, e.g. 'http client', 'retry logic'"],
  "body": "markdown"
}}]}}

Body requirements:
- rule bodies MUST contain exactly these five H2 sections, in order: \
{", ".join(f"'{s}'" for s in REQUIRED_RULE_SECTIONS)}. Ground every section in the chunk's \
own words and examples; keep each section 1-4 sentences or a short code/config example.
- skill bodies MUST contain '## When to use this skill' and '## Steps' (numbered).
- Never invent facts the chunk does not support. Stay faithful to the author's position, \
including contrarian ones."""


def distill_chunk(chunk: Chunk, settings: Settings, client: OpenAI) -> list[ArtifactInput]:
    """One chat call; returns [] when the model skips the chunk."""
    user_prompt = (
        f"Source URL: {chunk.source_url}\n"
        f"Section: {chunk.section or '(none)'}\n\n"
        f"Chunk:\n{chunk.text}"
    )
    try:
        response = client.chat.completions.create(
            model=settings.openrouter_agent_model,
            messages=[
                {"role": "system", "content": DISTILL_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:
        raise Errors.distill_failed(chunk.id, str(exc)) from exc
    return _parse_artifacts(chunk, response.choices[0].message.content or "")


def _parse_artifacts(chunk: Chunk, raw: str) -> list[ArtifactInput]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Errors.distill_failed(chunk.id, f"model returned non-JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise Errors.distill_failed(chunk.id, "model returned a non-object JSON payload")
    if payload.get("skip") is True:
        return []
    items = payload.get("artifacts")
    if not isinstance(items, list) or not items:
        raise Errors.distill_failed(
            chunk.id, "model returned neither {'skip': true} nor a non-empty 'artifacts' list"
        )
    return [_to_spec(chunk, item) for item in items]


def _to_spec(chunk: Chunk, item: Any) -> ArtifactInput:
    if not isinstance(item, dict):
        raise Errors.distill_failed(chunk.id, "artifact entry is not an object")
    intents = item.get("intents") or []
    try:
        return ArtifactInput(
            id=_slugify(str(item.get("id") or item.get("title") or "")),
            artifact_type=item.get("artifact_type"),
            category=_slugify(chunk.section or "general"),
            title=item.get("title"),
            severity=item.get("severity") if item.get("artifact_type") == "rule" else None,
            forced=bool(item.get("forced", False)),
            when_to_use=item.get("when_to_use"),
            applies_when=AppliesWhenInput(intents=[str(i) for i in intents] or None),
            source_url=chunk.source_url,
            source_ref=chunk.id,
            body=item.get("body"),
        )
    except ValidationError as exc:
        issues = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise Errors.distill_failed(chunk.id, f"invalid artifact from model: {issues}") from exc


def _slugify(text: str) -> str:
    return _SLUG.sub("-", text.lower()).strip("-")
