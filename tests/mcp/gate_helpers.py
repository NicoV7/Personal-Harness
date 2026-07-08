"""Shared builders for gate and hook-route tests.

Fakes exist ONLY at cross-module seams (retrieval pipeline, corpus
reader — both built by parallel agents); session store and audit log are
the real implementations against tmp_path, per the boundary-mocking
convention.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.audit import AuditLog
from app.corpus.schema import Artifact
from app.deps import Deps
from app.hooks.state import InMemorySessionStore
from app.settings import Settings


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = {
        "corpus_root": str(tmp_path / "corpus"),
        "audit_path": str(tmp_path / "audit.jsonl"),
        "bind_host": "127.0.0.1",
        "mcp_port": 7777,
        "token_path": str(tmp_path / "token"),
        "allowed_hosts": None,
        "redis_url": "redis://127.0.0.1:6379/0",
        "postgres_dsn": "postgresql://betterai:pw@127.0.0.1:5432/betterai",
        "openrouter_base_url": "https://openrouter.test/api/v1",
        "openrouter_api_key_file": str(tmp_path / "openrouter.key"),
        "openrouter_embedding_model": "openai/text-embedding-3-small",
        "openrouter_agent_model": "test/judge-model",
        "embedding_dim": 1536,
        "hybrid_fusion": "rrf",
        "hybrid_alpha": 0.5,
        "similarity_threshold": 0.35,
        "max_candidates": 100,
        "edit_granularity": "none",
        "memory_provider": "none",
        "plan_glob": "*.plan.md",
        "compose_file": str(tmp_path / "compose.yaml"),
        "docker_sock": "/var/run/docker.sock",
    }
    values.update(overrides)
    return Settings(**values)


def make_skill(skill_id: str, *, forced: bool = False) -> Artifact:
    return Artifact(
        id=skill_id,
        artifact_type="skill",
        title=skill_id.replace("-", " "),
        category="testing",
        when_to_use=f"Use when testing {skill_id}.",
        forced=forced,
    )


@dataclass(frozen=True)
class FakeScored:
    """Stand-in for the retrieval agent's ScoredArtifact wrapper."""

    artifact: Artifact
    score: float = 1.0


class FakeCorpus:
    def __init__(self, artifacts: list[Artifact] | None = None) -> None:
        self._artifacts = artifacts or []

    def read(self) -> list[Artifact]:
        return list(self._artifacts)

    def find(self, artifact_id: str) -> Artifact | None:
        return next((a for a in self._artifacts if a.id == artifact_id), None)

    def overridden_global_ids(self) -> list[str]:
        return []


class FakePipeline:
    def __init__(
        self,
        results: list[FakeScored] | None = None,
        error: Exception | None = None,
    ) -> None:
        self._results = results or []
        self._error = error
        self.queries: list[dict] = []

    async def query(
        self,
        *,
        intent: str,
        aspects: list[str] | None = None,
        file_paths: list[str] | None = None,
        symbols: list[str] | None = None,
        domain: str | None = None,
        artifact_type: str | None = None,
        top_k: int | None = None,
        on_progress=None,
    ) -> list[FakeScored]:
        self.queries.append({"intent": intent, "aspects": aspects, "top_k": top_k})
        if self._error is not None:
            raise self._error
        return list(self._results)

    async def index_corpus(self, artifacts: list[Artifact]) -> dict:
        return {"indexed": len(artifacts)}

    async def index_artifact(self, artifact: Artifact) -> None:
        return None

    async def health(self) -> dict:
        return {"ok": True}


def make_deps(
    tmp_path: Path,
    *,
    settings: Settings | None = None,
    pipeline: FakePipeline | None = None,
    corpus: FakeCorpus | None = None,
) -> Deps:
    resolved = settings or make_settings(tmp_path)
    return Deps(
        settings=resolved,
        audit=AuditLog(resolved.audit_path),
        corpus=corpus or FakeCorpus(),
        pipeline=pipeline or FakePipeline(),
        store=InMemorySessionStore(),
    )


def audit_events(deps: Deps) -> list[dict]:
    path = Path(deps.settings.audit_path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]
