"""Classification: one structured chat call fills ONLY missing facets.

Mirrors app/ingest/distill.py's client/parse posture: one attempt,
typed error on provider failure or malformed output, never a retry.
The body text is input context only — it is never rewritten.
"""

from __future__ import annotations

import json
import re

from openai import OpenAI, OpenAIError

from app.errors import Errors
from app.settings import Settings

_SLUG = re.compile(r"[^a-z0-9]+")

CLASSIFY_REF = "add_skill:classify"

CLASSIFY_SYSTEM_PROMPT = """You classify one corpus artifact for a coding-agent \
harness. You receive its existing YAML frontmatter, the list of MISSING facets, \
and the full markdown body. Fill ONLY the missing facets, grounded in the body. \
Reply with JSON only:

{"id": "kebab-case-id",
 "artifact_type": "rule" | "skill",   // rule = constraint (DO/DON'T); skill = procedure (HOW)
 "title": "one-line imperative",
 "category": "existing-style category, e.g. STANDARDS for rules or a short kebab area for skills",
 "domain": "kebab domain, e.g. maintainability, error-handling, testing",
 "severity": "low" | "medium" | "high",
 "when_to_use": "one sentence: the coding situation where this applies",
 "intents": ["5-10 short keyword phrases a coding agent would match on"]}

Include every requested facet. Do not invent facts the body does not support."""


def classify_missing(
    frontmatter: dict, body: str, missing: list[str], settings: Settings, client: OpenAI
) -> dict:
    """Facet name -> value for exactly the missing facets (intents land
    nested as applies_when.intents, merged over existing hints)."""
    user_prompt = (
        f"Existing frontmatter:\n{json.dumps(frontmatter, default=str)}\n\n"
        f"Missing facets to fill: {', '.join(missing)}\n\n"
        f"Body:\n{body}"
    )
    try:
        response = client.chat.completions.create(
            model=settings.openrouter_agent_model,
            messages=[
                {"role": "system", "content": CLASSIFY_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:
        raise Errors.distill_failed(CLASSIFY_REF, str(exc)) from exc
    return _facets(frontmatter, missing, response.choices[0].message.content or "")


def _facets(frontmatter: dict, missing: list[str], raw: str) -> dict:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Errors.distill_failed(CLASSIFY_REF, f"model returned non-JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise Errors.distill_failed(CLASSIFY_REF, "model returned a non-object JSON payload")
    filled: dict = {}
    for facet in missing:
        value = payload.get(facet)
        if value in (None, "", []):
            raise Errors.distill_failed(CLASSIFY_REF, f"model omitted requested facet {facet!r}")
        if facet == "intents":
            hints = dict(frontmatter.get("applies_when") or {})
            hints["intents"] = [str(item) for item in value]
            filled["applies_when"] = hints
        elif facet == "id":
            filled["id"] = _SLUG.sub("-", str(value).lower()).strip("-")
        else:
            filled[facet] = value
    return filled
