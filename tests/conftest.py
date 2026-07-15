"""Shared fixtures for the core-service tests.

Mocks live ONLY at system boundaries: the retrieval pipeline (redis/pg/
openrouter live behind the real one) is faked against its cross-module
contract; the corpus is REAL markdown materialized under tmp_path; the
audit log is a real JSONL file. Settings values are copied from
tests/config/unit/test_settings.py FULL_ENV with every filesystem path
repointed at tmp_path so tests never touch the host.
"""

from __future__ import annotations

import json
import textwrap
from dataclasses import dataclass
from pathlib import Path

import pytest

from app.audit import AuditLog
from app.corpus.reader import CorpusReader
from app.corpus.schema import Artifact
from app.deps import CallMeta, Deps
from app.errors import BetterAIError
from app.hooks.state import InMemorySessionStore
from app.settings import Settings

RULE_BODY = """## What this rule says

Fail loud. One attempt, typed error on failure.

## Why it matters

Retries mask real outages.

## When this applies

Any provider or infrastructure call.

## What good looks like

raise Errors.stack_unavailable(...)

## Anti-patterns

while True with backoff.
"""


def _write_markdown(path: Path, frontmatter: str, body: str) -> Path:
    # dedent keeps nested YAML indentation intact while letting fixtures
    # use naturally indented triple-quoted strings.
    rendered = textwrap.dedent(frontmatter).strip("\n")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{rendered}\n---\n\n{body}", encoding="utf-8")
    return path


@pytest.fixture
def write_markdown():
    return _write_markdown


@pytest.fixture
def rule_body() -> str:
    return RULE_BODY


@pytest.fixture
def corpus_root(tmp_path: Path) -> Path:
    root = tmp_path / "corpus"
    _write_markdown(
        root / "rules" / "STANDARDS" / "error-handling" / "fail-loud-no-retries.md",
        """
        id: fail-loud-no-retries
        title: Fail loud, never retry
        category: STANDARDS
        severity: high
        domain: error-handling
        applies_when:
          intents:
            - error handling
        """,
        RULE_BODY,
    )
    _write_markdown(
        root / "skills" / "planning" / "write-scoped-plan.md",
        """
        id: write-scoped-plan
        title: Write a scoped plan
        category: planning
        forced: true
        when_to_use: Before any multi-file change
        applies_when:
          intents:
            - plan
        """,
        "## Steps\n\n1. Enumerate the files to touch.\n",
    )
    _write_markdown(
        root / "skills" / "testing" / "write-pytest-fixture.md",
        """
        id: write-pytest-fixture
        title: Write a pytest fixture
        category: testing
        when_to_use: When adding tests
        """,
        "## Steps\n\n1. Arrange, act, assert.\n",
    )
    # A _meta tree the reader must skip (its file has no frontmatter, so
    # visiting it would fail loud and break every corpus test).
    meta_file = root / "rules" / "_meta" / "schema.md"
    meta_file.parent.mkdir(parents=True, exist_ok=True)
    meta_file.write_text("not an artifact", encoding="utf-8")
    return root


@pytest.fixture
def repo_root(tmp_path: Path) -> Path:
    root = tmp_path / "repo" / ".betterai"
    _write_markdown(
        root / "rules" / "STANDARDS" / "error-handling" / "fail-loud-no-retries.md",
        """
        id: fail-loud-no-retries
        title: Repo override
        category: STANDARDS
        severity: high
        domain: error-handling
        """,
        RULE_BODY,
    )
    return root


@pytest.fixture
def full_env(tmp_path: Path, corpus_root: Path) -> dict[str, str]:
    return {
        "BETTERAI_CORPUS_ROOT": str(corpus_root),
        "BETTERAI_AUDIT_PATH": str(tmp_path / "audit" / "audit.jsonl"),
        "BETTERAI_BIND_HOST": "127.0.0.1",
        "BETTERAI_MCP_PORT": "7777",
        "BETTERAI_TOKEN_PATH": str(tmp_path / "token"),
        "BETTERAI_REDIS_URL": "redis://redis:6379",
        "BETTERAI_POSTGRES_DSN": "postgresql://betterai:secret@postgres:5432/betterai",
        "BETTERAI_OPENROUTER_BASE_URL": "https://openrouter.example/api/v1",
        "BETTERAI_OPENROUTER_API_KEY_FILE": str(tmp_path / "openrouter-key"),
        "BETTERAI_OPENROUTER_EMBEDDING_MODEL": "provider/embed-model",
        "BETTERAI_OPENROUTER_AGENT_MODEL": "provider/judge-model",
        "BETTERAI_EMBEDDING_DIM": "384",
        "BETTERAI_HYBRID_FUSION": "rrf",
        "BETTERAI_HYBRID_ALPHA": "0.7",
        "BETTERAI_SIMILARITY_THRESHOLD": "0.35",
        "BETTERAI_MAX_CANDIDATES": "100",
        "BETTERAI_EDIT_GRANULARITY": "none",
        "BETTERAI_MEMORY_PROVIDER": "basic-memory",
        "BETTERAI_PLAN_GLOB": "**/.claude/plans/*.md",
        "BETTERAI_COMPOSE_FILE": str(tmp_path / "docker-compose.yml"),
        "BETTERAI_DOCKER_SOCK": str(tmp_path / "docker.sock"),
        "BETTERAI_PROMPT_IMPROVER_MODEL": "off",
        "BETTERAI_COMMENT_VERBOSITY": "default",
    }


@pytest.fixture
def settings(full_env: dict[str, str]) -> Settings:
    return Settings.from_env(full_env)


@dataclass
class FakeScored:
    """Duck-typed stand-in for the retrieval agent's ScoredArtifact: the
    tool layer touches only .artifact, .score, and .reason."""

    artifact: Artifact
    score: float
    reason: str = "scored"


class FakePipeline:
    """Implements the RetrievalPipeline cross-module contract at the
    system boundary. Mutate `results` / `index_error` per test."""

    def __init__(self) -> None:
        self.results: list[FakeScored] = []
        self.index_error: BetterAIError | None = None
        self.indexed: list[Artifact] = []
        self.index_corpus_calls: list[list[Artifact]] = []
        self.queries: list[dict] = []
        self.files_present_at_index: list[bool] = []

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
        self.queries.append(
            {
                "intent": intent,
                "aspects": aspects,
                "file_paths": file_paths,
                "symbols": symbols,
                "domain": domain,
                "artifact_type": artifact_type,
                "top_k": top_k,
            }
        )
        if on_progress is not None:
            await on_progress("results", {"count": len(self.results)})
        return self.results[:top_k] if top_k else list(self.results)

    async def index_corpus(self, artifacts: list[Artifact]) -> dict:
        batch = list(artifacts)
        self.index_corpus_calls.append(batch)
        return {"indexed": len(batch)}

    async def index_artifact(self, artifact: Artifact) -> None:
        if artifact.source_path:
            self.files_present_at_index.append(Path(artifact.source_path).exists())
        if self.index_error is not None:
            raise self.index_error
        self.indexed.append(artifact)

    async def health(self) -> dict:
        return {"redis": "ok", "postgres": "ok"}


@pytest.fixture
def pipeline() -> FakePipeline:
    return FakePipeline()


@pytest.fixture
def store() -> InMemorySessionStore:
    return InMemorySessionStore()


@pytest.fixture
def deps(
    settings: Settings,
    corpus_root: Path,
    repo_root: Path,
    pipeline: FakePipeline,
    store: InMemorySessionStore,
) -> Deps:
    return Deps(
        settings=settings,
        audit=AuditLog(settings.audit_path),
        corpus=CorpusReader(str(corpus_root), repo_root=str(repo_root)),
        pipeline=pipeline,
        store=store,
    )


@pytest.fixture
def meta() -> CallMeta:
    return CallMeta(
        agent_session_id="sess-main",
        parent_agent_session_id=None,
        subagent_class="main",
        tool_call_id="call-1",
    )


@pytest.fixture
def make_scored(deps: Deps):
    def _make(artifact_id: str, score: float = 0.9, reason: str = "scored") -> FakeScored:
        artifact = deps.corpus.find(artifact_id)
        assert artifact is not None, f"fixture corpus has no artifact {artifact_id!r}"
        return FakeScored(artifact=artifact, score=score, reason=reason)

    return _make


@pytest.fixture
def read_audit(settings: Settings):
    def _read() -> list[dict]:
        path = Path(settings.audit_path)
        if not path.exists():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    return _read
