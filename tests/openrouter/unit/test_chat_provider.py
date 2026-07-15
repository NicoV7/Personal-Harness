"""ChatClientProvider: one lazily-built client per process, key read once."""

from __future__ import annotations

import pytest

from app.errors import TokenMissingError
from app.openrouter import ChatClientProvider
from tests.mcp.gate_helpers import make_settings


def _write_key(tmp_path) -> None:
    (tmp_path / "openrouter.key").write_text("sk-test\n")


def test_get_reuses_one_client(tmp_path):
    # arrange
    _write_key(tmp_path)
    provider = ChatClientProvider(make_settings(tmp_path))

    # act
    first = provider.get()
    second = provider.get()

    # assert
    assert first is second


def test_key_file_read_exactly_once(tmp_path):
    # arrange
    _write_key(tmp_path)
    provider = ChatClientProvider(make_settings(tmp_path))
    provider.get()

    # act: a vanished key file must not matter after construction
    (tmp_path / "openrouter.key").unlink()

    # assert
    assert provider.get() is not None


def test_missing_key_raises_typed_error_lazily(tmp_path):
    # arrange: construction is safe, get() fails loud
    provider = ChatClientProvider(make_settings(tmp_path))

    # act / assert
    with pytest.raises(TokenMissingError):
        provider.get()
