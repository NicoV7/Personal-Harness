"""Source fetch: one attempt, no retries (fail-loud-no-retries)."""

from __future__ import annotations

import httpx

from app.errors import Errors

FETCH_TIMEOUT_SECONDS = 30.0


def fetch_html(url: str) -> str:
    try:
        response = httpx.get(url, timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise Errors.source_fetch_failed(url, str(exc)) from exc
    if response.status_code != 200:
        raise Errors.source_fetch_failed(url, f"HTTP {response.status_code}")
    return response.text
