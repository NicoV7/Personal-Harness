"""Prompt expansion (the "prompt improver"): one structured chat call
that rewrites a raw user prompt into retrieval signals — per-subproblem
aspects, candidate file paths, and symbols — so hybrid search captures
skills the literal prompt wording would miss.

Expansion is an enhancer, not a gate: the caller treats a typed failure
as a visible warning and falls back to raw-prompt retrieval (forced
skills are unaffected either way). Disabled explicitly with
BETTERAI_PROMPT_IMPROVER_MODEL=off — never silently.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from openai import OpenAI, OpenAIError

from app.errors import Errors
from app.settings import Settings

EXPANSION_OFF = "off"
MAX_ASPECTS = 8

EXPAND_SYSTEM_PROMPT = """You expand a coding-agent prompt into retrieval signals for a \
skills corpus (hybrid vector + keyword search over engineering rules/skills). Reply with \
JSON only:

{"aspects": ["2-8 short phrases, one per distinct sub-problem or coding concern implied \
by the prompt, e.g. 'http client error handling', 'database migrations', 'input validation'"],
 "file_paths": ["relative file paths the prompt names or clearly implies; [] if none"],
 "symbols": ["function/class/config names the prompt names; [] if none"]}

Name the underlying engineering concerns (testing, security, config, retries, schema \
design...), not just the prompt's literal words. Never invent paths or symbols the \
prompt does not support."""


@dataclass(frozen=True)
class Expansion:
    aspects: list[str] = field(default_factory=list)
    file_paths: list[str] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)


def expansion_enabled(settings: Settings) -> bool:
    return settings.prompt_improver_model != EXPANSION_OFF


def expand_prompt(prompt: str, settings: Settings, client: OpenAI) -> Expansion:
    """One chat call, one attempt; typed BAI-609 on any failure."""
    try:
        response = client.chat.completions.create(
            model=settings.prompt_improver_model,
            messages=[
                {"role": "system", "content": EXPAND_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
        )
    except OpenAIError as exc:
        raise Errors.expansion_failed(str(exc)) from exc
    return _parse(response.choices[0].message.content or "")


def _parse(raw: str) -> Expansion:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise Errors.expansion_failed(f"model returned non-JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise Errors.expansion_failed("model returned a non-object JSON payload")
    return Expansion(
        aspects=_str_list(payload.get("aspects"))[:MAX_ASPECTS],
        file_paths=_str_list(payload.get("file_paths")),
        symbols=_str_list(payload.get("symbols")),
    )


def _str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]
