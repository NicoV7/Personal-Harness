"""Plan-skill cache: LRU bound, upsert dedupe, plan-text helpers, mapping."""

from __future__ import annotations

from app.hooks.plan_cache import (
    PlanSkillCache,
    PlanSkillMatch,
    active_plan,
    now_iso,
    plan_content_hash,
    plan_sections,
    set_active_plan,
    strip_skill_audit,
)
from app.hooks.state import InMemorySessionStore
from tests.mcp.gate_helpers import make_skill


def _match(skill_id: str, score: float = 0.9) -> PlanSkillMatch:
    return PlanSkillMatch(
        artifact=make_skill(skill_id),
        score=score,
        provenance="plan section 'Approach'",
        served_at=now_iso(),
    )


class TestPlanSkillCache:
    def test_upsert_returns_only_matches_new_to_the_plan(self):
        # arrange
        cache = PlanSkillCache()
        first = cache.upsert("/p/plan.md", "h1", [_match("skill-a")])

        # act: a re-run returns the same skill plus one new one
        second = cache.upsert("/p/plan.md", "h2", [_match("skill-a"), _match("skill-b")])
        third = cache.upsert("/p/plan.md", "h2", [_match("skill-a"), _match("skill-b")])

        # assert
        assert [m.artifact.id for m in first] == ["skill-a"]
        assert [m.artifact.id for m in second] == ["skill-b"]
        assert third == []
        assert cache.get("/p/plan.md").content_hash == "h2"

    def test_existing_matches_keep_their_original_provenance(self):
        # arrange
        cache = PlanSkillCache()
        cache.upsert("/p/plan.md", "h1", [_match("skill-a")])

        # act: same skill re-matches under a different section
        replacement = PlanSkillMatch(
            artifact=make_skill("skill-a"),
            score=0.2,
            provenance="plan section 'Rollout'",
            served_at=now_iso(),
        )
        cache.upsert("/p/plan.md", "h2", [replacement])

        # assert
        assert (
            cache.get("/p/plan.md").matches["skill-a"].provenance
            == "plan section 'Approach'"
        )

    def test_lru_bound_evicts_least_recent_plan(self):
        # arrange
        cache = PlanSkillCache(max_plans=2)
        cache.upsert("/p/one.md", "h", [_match("skill-a")])
        cache.upsert("/p/two.md", "h", [_match("skill-b")])

        # act
        cache.upsert("/p/three.md", "h", [_match("skill-c")])

        # assert
        assert cache.get("/p/one.md") is None
        assert cache.get("/p/two.md") is not None
        assert cache.latest().plan_path == "/p/three.md"

    def test_latest_follows_update_recency_not_creation_order(self):
        # arrange
        cache = PlanSkillCache()
        cache.upsert("/p/one.md", "h1", [_match("skill-a")])
        cache.upsert("/p/two.md", "h1", [_match("skill-b")])

        # act
        cache.upsert("/p/one.md", "h2", [])

        # assert
        assert cache.latest().plan_path == "/p/one.md"

    def test_empty_cache_has_no_latest(self):
        # arrange / act / assert
        assert PlanSkillCache().latest() is None

    def test_paths_are_normalized_on_get_and_upsert(self):
        # arrange
        cache = PlanSkillCache()
        cache.upsert("/p/sub/../plan.md", "h", [_match("skill-a")])

        # act / assert
        assert cache.get("/p/plan.md") is not None


class TestPlanTextHelpers:
    def test_strip_skill_audit_removes_exactly_that_section(self):
        # arrange
        markdown = (
            "# Title\n\n## Approach\nbody\n\n## Skill Audit\n\n"
            "### Skills Consulted\n| a | b |\n\n## Testing\npytest\n"
        )

        # act
        stripped = strip_skill_audit(markdown)

        # assert
        assert "Skill Audit" not in stripped
        assert "Skills Consulted" not in stripped
        assert "## Approach" in stripped
        assert "## Testing" in stripped

    def test_strip_is_stable_for_hashing(self):
        # arrange
        base = "# T\n\n## Approach\nbody\n"
        with_audit = base + "\n## Skill Audit\n| x | y |\n"

        # act / assert: adding the audit section never changes the hash
        assert plan_content_hash(strip_skill_audit(base)) == plan_content_hash(
            strip_skill_audit(with_audit)
        )
        assert plan_content_hash("a") != plan_content_hash("b")

    def test_plan_sections_split_on_h2_with_preamble(self):
        # arrange
        markdown = (
            "# Title\nintro text\n\n## Approach\nadd retries\n\n"
            '## Testing\nassert {"json": true} braces survive\n'
        )

        # act
        sections = plan_sections(markdown)

        # assert: preamble rides as '', symbol-heavy bodies stay intact
        assert sections[0][0] == ""
        assert "intro text" in sections[0][1]
        assert sections[1] == ("Approach", "add retries")
        assert sections[2][0] == "Testing"
        assert '{"json": true}' in sections[2][1]

    def test_sub_headings_stay_inside_their_section(self):
        # arrange / act
        sections = plan_sections("## Approach\n### Detail\nnested\n")

        # assert
        assert len(sections) == 1
        assert "### Detail" in sections[0][1]


class TestSessionMapping:
    def test_round_trip_and_normalization(self):
        # arrange
        store = InMemorySessionStore()

        # act
        set_active_plan(store, "sess-1", "/p/sub/../plan.md")

        # assert
        assert active_plan(store, "sess-1") == "/p/plan.md"
        assert active_plan(store, "sess-other") is None

    def test_null_session_is_a_no_op(self):
        # arrange
        store = InMemorySessionStore()

        # act
        set_active_plan(store, None, "/p/plan.md")

        # assert
        assert active_plan(store, None) is None
        assert store.session_count() == 0
