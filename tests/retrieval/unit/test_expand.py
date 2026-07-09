"""Prompt expansion parsing: valid payload, off switch, typed failures."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.errors import ExpansionError
from app.retrieval.expand import MAX_ASPECTS, expand_prompt, expansion_enabled
from tests.retrieval.conftest import build_settings


class FakeChatClient:
    def __init__(self, payload: str) -> None:
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=lambda **kwargs: self._response(payload))
        )

    @staticmethod
    def _response(payload: str):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=payload))]
        )


def _settings(model: str = "test/improver"):
    return build_settings(prompt_improver_model=model)


class TestExpandPrompt:
    def test_valid_payload_becomes_expansion(self):
        # arrange
        client = FakeChatClient(
            json.dumps(
                {
                    "aspects": ["http client error handling", "retries"],
                    "file_paths": ["app/http_client.py"],
                    "symbols": ["fetch_data"],
                }
            )
        )

        # act
        expansion = expand_prompt("fix the http client", _settings(), client)

        # assert
        assert expansion.aspects == ["http client error handling", "retries"]
        assert expansion.file_paths == ["app/http_client.py"]
        assert expansion.symbols == ["fetch_data"]

    def test_aspect_list_is_capped(self):
        client = FakeChatClient(
            json.dumps({"aspects": [f"aspect {i}" for i in range(20)]})
        )
        expansion = expand_prompt("do everything", _settings(), client)
        assert len(expansion.aspects) == MAX_ASPECTS

    def test_non_json_fails_with_typed_error(self):
        client = FakeChatClient("let me think about that")
        with pytest.raises(ExpansionError):
            expand_prompt("prompt", _settings(), client)

    def test_non_string_entries_are_dropped_not_crashed(self):
        client = FakeChatClient(json.dumps({"aspects": ["ok", 3, None, "  "]}))
        expansion = expand_prompt("prompt", _settings(), client)
        assert expansion.aspects == ["ok"]


class TestExpansionEnabled:
    def test_off_disables(self):
        assert expansion_enabled(_settings("off")) is False

    def test_model_id_enables(self):
        assert expansion_enabled(_settings("openai/gpt-test")) is True
