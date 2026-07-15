"""Lean retrieval facade: the `Deps.pipeline` contract over redisvl.

query()        -> search.py (HybridQuery per aspect + threshold/keyword filter)
index_corpus() -> ingest.py (embed via redisvl vectorizer; PG then Redis)

Artifacts are mapped back from hit ids via the in-memory map fed by the
ingest calls; a miss means the index outlived the corpus and the fix is
`betterai index` (said in the error, never guessed around).
"""

from __future__ import annotations

from dataclasses import dataclass

from app.corpus.schema import Artifact
from app.errors import Errors
from app.retrieval.ingest import INDEXED_ARTIFACT_TYPES, ingest, make_index, make_vectorizer
from app.retrieval.search import hit_score, search
from app.settings import Settings


@dataclass(frozen=True)
class ScoredArtifact:
    """One retrieval result: the tool layer reads .artifact/.score/.reason."""

    artifact: Artifact
    score: float
    reason: str = "hybrid"


class Retrieval:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        # Lazy: constructing the vectorizer probes the embedding provider
        # (redisvl validates the key with a live call). Boot must survive
        # a provider outage — the probe happens on first use and surfaces
        # as typed BAI-604 per query/index instead of a boot crash-loop.
        self._vectorizer: OpenAITextVectorizer | None = None
        self._index = make_index(settings)
        self._artifacts: dict[str, Artifact] = {}

    def _get_vectorizer(self) -> OpenAITextVectorizer:
        if self._vectorizer is None:
            self._vectorizer = make_vectorizer(self._settings)
        return self._vectorizer

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
    ) -> list[ScoredArtifact]:
        hits = search(
            intent,
            vectorizer=self._get_vectorizer(),
            index=self._index,
            settings=self._settings,
            aspects=aspects,
            domain=domain,
            artifact_type=artifact_type,
            top_k=top_k,
        )
        results = [
            ScoredArtifact(self._artifact_for(hit), score=hit_score(hit), reason="hybrid")
            for hit in hits
        ]
        if on_progress is not None:
            await on_progress(
                "results",
                {
                    "count": len(results),
                    "top": [{"id": r.artifact.id, "score": r.score} for r in results[:5]],
                },
            )
        return results

    async def index_corpus(self, artifacts: list[Artifact]) -> dict:
        summary = ingest(
            artifacts, vectorizer=self._get_vectorizer(), index=self._index, settings=self._settings
        )
        self._remember(artifacts)
        return summary

    async def index_artifact(self, artifact: Artifact) -> None:
        ingest(
            [artifact], vectorizer=self._get_vectorizer(), index=self._index, settings=self._settings
        )
        self._remember([artifact])

    async def health(self) -> dict:
        return {"artifacts": len(self._artifacts), "index": self._index.name}

    def _remember(self, artifacts: list[Artifact]) -> None:
        self._artifacts.update(
            {a.id: a for a in artifacts if a.artifact_type in INDEXED_ARTIFACT_TYPES}
        )

    def _artifact_for(self, hit: dict) -> Artifact:
        artifact = self._artifacts.get(str(hit.get("id")))
        if artifact is None:
            raise Errors.query_error(
                f"index returned {hit.get('id')!r} but the corpus map has no such artifact; "
                "run `betterai index` to resync"
            )
        return artifact
