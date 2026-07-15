"""Search: threshold + keyword selection, aspects union, optional top_k."""

import pytest

from importlib import import_module

from app.errors import QueryError
from app.retrieval.search import search

# The package re-exports the `search` function, shadowing the submodule
# attribute — import_module gets the module itself for monkeypatching.
search_module = import_module("app.retrieval.search")
from tests.retrieval.conftest import build_settings

DIM = 4


class StubHybridQuery:
    """Captures HybridQuery kwargs so the fake index can route on text —
    the real class hides its query text behind redis syntax internals."""

    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self.text = kwargs["text"]


@pytest.fixture(autouse=True)
def stub_hybrid_query(monkeypatch):
    monkeypatch.setattr(search_module, "HybridQuery", StubHybridQuery)


class FakeVectorizer:
    def embed(self, text):
        return [1.0] + [0.0] * (DIM - 1)

    def embed_many(self, texts, batch_size=64):
        return [self.embed(text) for text in texts]


class FakeIndex:
    """Serves canned hits per query text (keyed by substring match)."""

    def __init__(self, hits_by_text: dict[str, list[dict]]) -> None:
        self._hits_by_text = hits_by_text
        self.queries: list = []

    def query(self, hybrid_query):
        self.queries.append(hybrid_query)
        for needle, hits in self._hits_by_text.items():
            if needle in hybrid_query.text:
                return list(hits)
        return []


def _hit(hit_id: str, sim: float, text_score: float | None = None, **fields) -> dict:
    hit = {"id": hit_id, "vector_similarity": str(sim), "hybrid_score": str(sim), **fields}
    if text_score is not None:
        hit["text_score"] = str(text_score)
    return hit


@pytest.fixture
def settings():
    return build_settings(embedding_dim=DIM, similarity_threshold=0.5)


class TestFtSanitizer:
    def test_json_prompt_reaches_index_without_metacharacters(self, settings):
        # arrange: the BAI-602 regression — pasted JSON/transcript prompts
        index = FakeIndex({"network": [_hit("relevant-rule", sim=0.8, text_score=2.5)]})
        prompt = 'Edit failed {"block": true} @gate | (retry-now) "network" errors*'

        # act
        hits = search(prompt, vectorizer=FakeVectorizer(), index=index, settings=settings)

        # assert
        sent = index.queries[0].text
        assert not set(sent) & set('{}"@|()*:~[]')
        assert "network" in sent
        assert [hit["id"] for hit in hits] == ["relevant-rule"]

    def test_all_symbol_prompt_skips_text_leg_instead_of_crashing(self, settings):
        # arrange
        index = FakeIndex({"anything": [_hit("x", sim=0.9)]})

        # act
        hits = search('{}[]()*@|~"', vectorizer=FakeVectorizer(), index=index, settings=settings)

        # assert: no query reaches redis, no crash, honest empty result
        assert hits == []
        assert index.queries == []

    def test_short_tokens_survive_sanitizing(self, settings):
        # arrange: FT tokens keep 1-2 char words the keyword tokenizer drops
        index = FakeIndex({"go db": [_hit("go-db-rule", sim=0.8, text_score=1.0)]})

        # act
        hits = search("fix go db {bug}", vectorizer=FakeVectorizer(), index=index, settings=settings)

        # assert
        assert [hit["id"] for hit in hits] == ["go-db-rule"]


class TestSelectionRule:
    def test_keeps_only_above_threshold_with_keyword_match(self, settings):
        # arrange
        index = FakeIndex(
            {
                "network": [
                    _hit("relevant-rule", sim=0.8, text_score=2.5),
                    _hit("semantic-only", sim=0.9, text_score=0.0),
                    _hit("below-threshold", sim=0.2, text_score=3.0),
                ]
            }
        )
        # act
        hits = search(
            "network errors",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
        )
        # assert
        assert [hit["id"] for hit in hits] == ["relevant-rule"]

    def test_token_overlap_fallback_when_no_text_score(self, settings):
        # arrange
        index = FakeIndex(
            {
                "network": [
                    _hit("titled-match", sim=0.8, title="Network failure handling"),
                    _hit("no-overlap", sim=0.8, title="Design tokens"),
                ]
            }
        )
        # act
        hits = search(
            "network errors",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
        )
        # assert
        assert [hit["id"] for hit in hits] == ["titled-match"]

    def test_missing_similarity_field_fails_loud(self, settings):
        # arrange
        index = FakeIndex({"network": [{"id": "broken-hit", "text_score": "1.0"}]})
        # act / assert
        with pytest.raises(QueryError):
            search(
                "network errors",
                vectorizer=FakeVectorizer(),
                index=index,
                settings=settings,
            )

    def test_keyword_only_union_members_are_skipped_not_fatal(self, settings):
        # arrange: RRF unions both legs — a hit the vector leg never scored
        # carries no vector_similarity and must be dropped, not crash the query
        index = FakeIndex(
            {
                "network": [
                    _hit("scored-hit", 0.9, text_score=1.0, title="network"),
                    {"id": "keyword-only-hit", "text_score": "9.9", "title": "network"},
                ]
            }
        )
        # act
        hits = search(
            "network errors",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
        )
        # assert
        assert [hit["id"] for hit in hits] == ["scored-hit"]


class TestAspects:
    def test_each_aspect_runs_its_own_query_and_results_union(self, settings):
        # arrange
        index = FakeIndex(
            {
                "network": [_hit("net-rule", sim=0.8, text_score=1.0)],
                "testing": [_hit("test-rule", sim=0.7, text_score=1.0)],
            }
        )
        # act
        hits = search(
            "build the payment feature",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
            aspects=["network error handling", "testing the feature"],
        )
        # assert
        assert {hit["id"] for hit in hits} == {"net-rule", "test-rule"}
        assert len(index.queries) == 3  # prompt + two aspects

    def test_duplicate_hits_keep_best_score(self, settings):
        # arrange
        index = FakeIndex(
            {
                "network": [_hit("shared-rule", sim=0.6, text_score=1.0)],
                "sockets": [_hit("shared-rule", sim=0.9, text_score=1.0)],
            }
        )
        # act
        hits = search(
            "network calls",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
            aspects=["sockets reconnect"],
        )
        # assert
        assert len(hits) == 1
        assert float(hits[0]["hybrid_score"]) == pytest.approx(0.9)

    def test_empty_prompt_and_aspects_fail_loud(self, settings):
        # arrange / act / assert
        with pytest.raises(QueryError):
            search(
                "  ",
                vectorizer=FakeVectorizer(),
                index=FakeIndex({}),
                settings=settings,
            )


class TestTopK:
    def test_omitted_top_k_returns_everything_above_threshold(self, settings):
        # arrange
        hits = [_hit(f"rule-{n}", sim=0.8, text_score=1.0) for n in range(7)]
        index = FakeIndex({"network": hits})
        # act
        results = search(
            "network", vectorizer=FakeVectorizer(), index=index, settings=settings
        )
        # assert
        assert len(results) == 7

    def test_top_k_caps_after_ranking(self, settings):
        # arrange
        index = FakeIndex(
            {
                "network": [
                    _hit("low", sim=0.6, text_score=1.0),
                    _hit("high", sim=0.95, text_score=1.0),
                    _hit("mid", sim=0.8, text_score=1.0),
                ]
            }
        )
        # act
        results = search(
            "network",
            vectorizer=FakeVectorizer(),
            index=index,
            settings=settings,
            top_k=2,
        )
        # assert
        assert [hit["id"] for hit in results] == ["high", "mid"]
