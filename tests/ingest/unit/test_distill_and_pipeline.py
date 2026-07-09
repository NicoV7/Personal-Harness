"""Distiller parsing (fake chat client) and pipeline round-trip (fake
distiller + fake index): no network, no LLM.
"""

from __future__ import annotations

import dataclasses
import json
from types import SimpleNamespace

import pytest

from app.corpus.reader import CorpusReader
from app.corpus.schema import REQUIRED_RULE_SECTIONS
from app.corpus.writer import AppliesWhenInput, ArtifactInput
from app.errors import DistillError
from app.ingest.chunk import Chunk
from app.ingest.distill import distill_chunk
from app.ingest.pipeline import run_ingest
from tests.mcp.gate_helpers import FakePipeline, make_deps, make_settings

RULE_BODY = "\n\n".join(f"{section}\n\nContent." for section in REQUIRED_RULE_SECTIONS)
CHUNK = Chunk(
    id="writing-acceptable-backend-code#0",
    source_url="https://august.mataroa.blog/blog/writing-acceptable-backend-code/",
    section=None,
    text="Do not do retries. Retries are the sign of the weak.",
)


class FakeChatClient:
    """Mimics openai.OpenAI far enough for distill_chunk."""

    def __init__(self, payload: str) -> None:
        self.chat = SimpleNamespace(
            completions=SimpleNamespace(create=lambda **kwargs: self._response(payload))
        )

    @staticmethod
    def _response(payload: str):
        message = SimpleNamespace(content=payload)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def _model_artifact(**overrides) -> dict:
    values = dict(
        id="no-retries",
        artifact_type="rule",
        title="Do not do retries",
        severity="high",
        forced=True,
        when_to_use="Use when writing code that calls other services.",
        intents=["retries", "backoff", "http client", "resilience", "error handling"],
        body=RULE_BODY,
    )
    values.update(overrides)
    return values


class TestDistill:
    def test_valid_response_becomes_specs_with_provenance(self, tmp_path):
        # arrange
        client = FakeChatClient(json.dumps({"artifacts": [_model_artifact()]}))

        # act
        specs = distill_chunk(CHUNK, make_settings(tmp_path), client)

        # assert
        assert len(specs) == 1
        spec = specs[0]
        assert spec.id == "no-retries"
        assert spec.forced is True
        assert spec.source_url == CHUNK.source_url
        assert spec.source_ref == CHUNK.id
        assert spec.category == "general"  # no section heading on this chunk

    def test_skip_sentinel_returns_empty_list(self, tmp_path):
        client = FakeChatClient(json.dumps({"skip": True}))
        assert distill_chunk(CHUNK, make_settings(tmp_path), client) == []

    def test_non_json_response_fails_loud(self, tmp_path):
        client = FakeChatClient("I would rather chat about it")
        with pytest.raises(DistillError):
            distill_chunk(CHUNK, make_settings(tmp_path), client)

    def test_invalid_artifact_shape_fails_loud(self, tmp_path):
        client = FakeChatClient(json.dumps({"artifacts": [{"id": "x"}]}))
        with pytest.raises(DistillError):
            distill_chunk(CHUNK, make_settings(tmp_path), client)


class TestPipeline:
    async def test_run_ingest_writes_reader_valid_artifacts_and_audits(self, tmp_path):
        # arrange
        corpus_root = tmp_path / "corpus"
        settings = make_settings(tmp_path, corpus_root=str(corpus_root))
        deps = make_deps(tmp_path, settings=settings, pipeline=FakePipeline())
        deps = dataclasses.replace(deps, corpus=CorpusReader(str(corpus_root)))
        spec = ArtifactInput(
            **{k: v for k, v in _model_artifact().items() if k != "intents"},
            applies_when=AppliesWhenInput(intents=["retries", "backoff"]),
            category="backend-code",
            source_url=CHUNK.source_url,
            source_ref=CHUNK.id,
        )

        # act
        summary = await run_ingest(
            CHUNK.source_url,
            deps,
            fetch=lambda url: "<article><p>Do not do retries. It never helps.</p></article>",
            distill=lambda chunk: [spec],
        )

        # assert
        assert summary["written"] == 1
        assert summary["ids"] == ["no-retries"]
        loaded = CorpusReader(str(corpus_root)).read()
        assert loaded[0].id == "no-retries"
        assert loaded[0].forced is True
        assert loaded[0].source_ref == CHUNK.id
        events = (tmp_path / "audit.jsonl").read_text()
        assert '"ingest"' in events

    async def test_skipped_chunks_are_counted_not_silently_dropped(self, tmp_path):
        # arrange
        corpus_root = tmp_path / "corpus"
        settings = make_settings(tmp_path, corpus_root=str(corpus_root))
        deps = make_deps(tmp_path, settings=settings, pipeline=FakePipeline())
        deps = dataclasses.replace(deps, corpus=CorpusReader(str(corpus_root)))

        # act
        summary = await run_ingest(
            CHUNK.source_url,
            deps,
            fetch=lambda url: "<article><p>Nothing actionable here, just some intro prose "
            "that rambles on far past the merge threshold so it forms one chunk of its own "
            "and reaches the distiller which then decides to skip it entirely as chatter, "
            "leaving the corpus untouched and the skip counter incremented.</p></article>",
            distill=lambda chunk: [],
        )

        # assert
        assert summary == {
            "url": CHUNK.source_url,
            "written": 0,
            "skipped_chunks": 1,
            "ids": [],
        }
