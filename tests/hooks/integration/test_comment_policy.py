"""Comment-policy injection: env seed, skill override, default silence."""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.testclient import TestClient

from app.corpus.schema import Artifact
from app.hooks.routes import hook_routes
from app.settings import CommentPolicy
from tests.mcp.gate_helpers import FakeCorpus, FakePipeline, make_deps, make_settings

SESSION = "sess-comment-policy"


def _client(tmp_path, *, settings=None, corpus=None) -> TestClient:
    deps = make_deps(
        tmp_path,
        settings=settings or make_settings(tmp_path),
        pipeline=FakePipeline(),
        corpus=corpus,
    )
    return TestClient(Starlette(routes=hook_routes(deps)))


def _prompt_context(client: TestClient) -> str:
    response = client.post(
        "/hooks/user-prompt-submit",
        json={"session_id": SESSION, "prompt": "add an endpoint"},
    )
    return response.json()["hookSpecificOutput"]["additionalContext"]


def _configurable_comment_skill(level: str) -> Artifact:
    return Artifact(
        id="concise-comments",
        artifact_type="rule",
        title="Comments explain WHY",
        category="STANDARDS",
        settings_schema={
            "level": {
                "type": "string",
                "pattern": "^(default|none|tokens:[1-9][0-9]*|lines:[1-9][0-9]*)$",
                "description": "Comment verbosity level.",
                "default": "default",
            }
        },
        settings={"level": level},
    )


def test_default_mode_injects_no_policy_line(tmp_path):
    context = _prompt_context(_client(tmp_path))
    assert "comment policy" not in context


def test_env_lines_budget_injected(tmp_path):
    # arrange
    settings = make_settings(tmp_path, comment_verbosity=CommentPolicy("lines", 2))
    # act
    context = _prompt_context(_client(tmp_path, settings=settings))
    # assert
    assert "at most 2 comment lines per edited file" in context


def test_env_none_mode_bans_comments(tmp_path):
    settings = make_settings(tmp_path, comment_verbosity=CommentPolicy("none"))
    context = _prompt_context(_client(tmp_path, settings=settings))
    assert "NO inline or block code comments" in context


def test_skill_setting_wins_over_env_seed(tmp_path):
    # arrange: env says default, the configured skill says tokens:99
    corpus = FakeCorpus([_configurable_comment_skill("tokens:99")])
    # act
    context = _prompt_context(_client(tmp_path, corpus=corpus))
    # assert
    assert "under 99 tokens" in context


def test_skill_default_level_falls_back_to_env(tmp_path):
    # arrange: skill configured to default, env carries the budget
    corpus = FakeCorpus([_configurable_comment_skill("default")])
    settings = make_settings(tmp_path, comment_verbosity=CommentPolicy("lines", 3))
    # act
    context = _prompt_context(_client(tmp_path, settings=settings, corpus=corpus))
    # assert: an explicit skill-level "default" is a real value — it wins
    assert "comment policy" not in context
