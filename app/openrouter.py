"""One home for constructing the OpenRouter chat client (openai SDK
pointed at the OpenRouter base URL, key read from the mounted key file).
Shared by the ingest distiller and the prompt expander.
"""

from __future__ import annotations

from pathlib import Path

from openai import OpenAI

from app.errors import Errors
from app.settings import Settings


def make_chat_client(settings: Settings) -> OpenAI:
    key_path = Path(settings.openrouter_api_key_file)
    if not key_path.exists() or not key_path.read_text().strip():
        raise Errors.token_missing(str(key_path))
    return OpenAI(base_url=settings.openrouter_base_url, api_key=key_path.read_text().strip())
