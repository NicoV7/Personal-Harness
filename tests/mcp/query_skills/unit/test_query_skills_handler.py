"""query_skills: receipt, ranked rows, forced injection, read-gate ids, audit."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.deps import CallMeta
from app.mcp.query_skills.handler import handle
from app.mcp.query_skills.schema import INPUT_MODEL


class TestQuerySkills:
    async def test_returns_ranked_artifacts_and_marks_receipt(
        self, deps, meta, pipeline, make_scored
    ):
        # arrange
        pipeline.results = [make_scored("write-pytest-fixture", score=0.9)]
        payload = INPUT_MODEL(context={"intent": "write tests for the reader"})
        # act
        out = await handle(payload, deps, meta)
        # assert
        assert out["match"] == "matched"
        row = out["artifacts"][0]
        assert row["id"] == "write-pytest-fixture"
        assert row["artifact_type"] == "skill"
        assert row["score"] == 0.9
        assert row["reason"] == "scored"
        assert row["when_to_use"] == "When adding tests"
        assert deps.store.get("sess-main", "retrieval_receipt", "retrieved") is True

    async def test_forced_skill_injected_on_intent_match(self, deps, meta):
        # arrange (pipeline returns nothing; forced skill applies_when
        # intents contains "plan")
        payload = INPUT_MODEL(context={"intent": "plan the payment migration"})
        # act
        out = await handle(payload, deps, meta)
        # assert
        forced = [row for row in out["artifacts"] if row["reason"] == "forced"]
        assert [row["id"] for row in forced] == ["write-scoped-plan"]
        assert forced[0]["score"] == 1.0
        assert out["match"] == "matched"

    async def test_read_gate_required_ids_merge_with_existing(self, deps, meta):
        # arrange
        deps.store.set("sess-main", "read_gate", "required", ["existing-skill"])
        payload = INPUT_MODEL(context={"intent": "plan the migration"})
        # act
        await handle(payload, deps, meta)
        # assert
        assert deps.store.get("sess-main", "read_gate", "required") == [
            "existing-skill",
            "write-scoped-plan",
        ]

    async def test_omitted_top_k_means_uncapped_threshold_selection(self, deps, meta, pipeline):
        # arrange
        payload = INPUT_MODEL(context={"intent": "anything"})
        # act
        await handle(payload, deps, meta)
        # assert
        assert pipeline.queries[0]["top_k"] is None

    def test_top_k_above_32_rejected_at_the_edge(self):
        # arrange / act / assert
        with pytest.raises(ValidationError):
            INPUT_MODEL(context={"intent": "x"}, top_k=64)

    async def test_no_results_and_no_forced_match_is_none(self, deps, meta):
        # arrange (intent matches neither pipeline results nor forced hints)
        payload = INPUT_MODEL(context={"intent": "refactor the auth module"})
        # act
        out = await handle(payload, deps, meta)
        # assert
        assert out["match"] == "none"
        assert out["artifacts"] == []

    async def test_overridden_global_ids_surface_in_output(self, deps, meta):
        # arrange
        payload = INPUT_MODEL(context={"intent": "anything"})
        # act
        out = await handle(payload, deps, meta)
        # assert (repo fixture overrides this rule id)
        assert out["overridden_global_ids"] == ["fail-loud-no-retries"]

    async def test_progress_callback_is_threaded_to_pipeline(self, deps, meta):
        # arrange
        stages: list[str] = []

        async def on_progress(stage: str, payload: dict) -> None:
            stages.append(stage)

        # act
        await handle(INPUT_MODEL(context={"intent": "x"}), deps, meta, on_progress=on_progress)
        # assert
        assert stages == ["results"]

    async def test_audit_retrieve_event_carries_meta_and_ids(
        self, deps, meta, read_audit
    ):
        # arrange
        payload = INPUT_MODEL(context={"intent": "plan the migration"})
        # act
        await handle(payload, deps, meta)
        # assert
        event = read_audit()[-1]
        assert event["event_type"] == "retrieve"
        assert event["agent_session_id"] == "sess-main"
        assert event["tool_call_id"] == "call-1"
        assert event["payload"]["returned"] == ["write-scoped-plan"]
        assert event["payload"]["forced"] == ["write-scoped-plan"]
        assert event["payload"]["match"] == "matched"

    async def test_missing_session_id_skips_receipt_and_read_gate(self, deps):
        # arrange
        anonymous = CallMeta(
            agent_session_id=None,
            parent_agent_session_id=None,
            subagent_class="main",
            tool_call_id="call-2",
        )
        # act
        out = await handle(INPUT_MODEL(context={"intent": "plan it"}), deps, anonymous)
        # assert (no receipt recorded for any session, output still served)
        assert out["match"] == "matched"
        assert deps.store.get("sess-main", "retrieval_receipt", "retrieved") is None
