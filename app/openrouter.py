"""One home for constructing the OpenRouter chat client (openai SDK
pointed at the OpenRouter base URL, key read from the mounted key file).
Shared by the ingest distiller, add_skill, and the prompt expander via
the ChatClientProvider wired into Deps at boot.
"""

from __future__ import annotations

from pathlib import Path

from openai import OpenAI

from app.errors import Errors
from app.settings import Settings


def make_chat_client(settings: Settings) -> OpenAI:
    key_path = Path(settings.openrouter_api_key_file)
    key = key_path.read_text().strip() if key_path.exists() else ""
    if not key:
        raise Errors.token_missing(str(key_path))
    return OpenAI(base_url=settings.openrouter_base_url, api_key=key)


class ChatClientProvider:
    """Lazy per-process client (mirrors the retrieval lazy-vectorizer):
    the OpenAI client owns an httpx pool, so per-request construction
    leaks connections. token_missing still raises per call site, lazily."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: OpenAI | None = None

    def get(self) -> OpenAI:
        if self._client is None:
            self._client = make_chat_client(self._settings)
        return self._client
