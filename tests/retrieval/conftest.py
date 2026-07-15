"""Shared builders for retrieval tests.

Settings are constructed directly (never from os.environ) so every test
states its configuration literally; only the integration module goes
through Settings.from_env, because talking to real containers is its
entire point.
"""

from __future__ import annotations

import pytest

from app.corpus.schema import AppliesWhen, Artifact
from app.settings import CommentPolicy, Settings

EMBEDDING_DIM = 8


def build_settings(**overrides) -> Settings:
    values = dict(
        corpus_root="/corpus",
        audit_path="/audit/audit.jsonl",
        bind_host="127.0.0.1",
        mcp_port=7777,
        token_path="/secrets/token",
        allowed_hosts=("127.0.0.1:7777",),
        redis_url="redis://127.0.0.1:6379",
        postgres_dsn="postgresql://betterai:pw@127.0.0.1:5432/betterai",
        openrouter_base_url="https://openrouter.test/api/v1",
        openrouter_api_key_file="/secrets/openrouter-key",
        openrouter_embedding_model="openai/text-embedding-3-small",
        openrouter_agent_model="openai/gpt-test",
        prompt_improver_model="off",
        embedding_dim=EMBEDDING_DIM,
        hybrid_fusion="linear",
        hybrid_alpha=0.7,
        similarity_threshold=0.35,
        max_candidates=100,
        edit_granularity="none",
        memory_provider="none",
        plan_glob="~/.claude/plans/*.md",
        compose_file="/compose/docker-compose.yml",
        docker_sock="/var/run/docker.sock",
        comment_verbosity=CommentPolicy("default"),
    )
    values.update(overrides)
    return Settings(**values)


def build_artifact(artifact_id: str = "fail-loud-no-retries", **overrides) -> Artifact:
    values = dict(
        id=artifact_id,
        artifact_type="rule",
        title=f"Title for {artifact_id}",
        category="error-handling",
        severity="high",
        applies_when=AppliesWhen(intents=["error handling", "http client"]),
        body=f"## What this rule says\nBody of {artifact_id}.",
        content_hash=None,
    )
    values.update(overrides)
    return Artifact(**values)


@pytest.fixture
def settings() -> Settings:
    return build_settings()
