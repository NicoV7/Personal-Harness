"""Settings are required-keys-only: no defaults anywhere."""

import pytest

from app.errors import ConfigInvalidError, ConfigMissingError
from app.settings import REQUIRED_KEYS, CommentPolicy, Settings, parse_comment_policy

FULL_ENV = {
    "BETTERAI_CORPUS_ROOT": "/data",
    "BETTERAI_AUDIT_PATH": "/data/audit/audit.jsonl",
    "BETTERAI_BIND_HOST": "127.0.0.1",
    "BETTERAI_MCP_PORT": "7777",
    "BETTERAI_TOKEN_PATH": "/data/token",
    "BETTERAI_REDIS_URL": "redis://redis:6379",
    "BETTERAI_POSTGRES_DSN": "postgresql://betterai:secret@postgres:5432/betterai",
    "BETTERAI_OPENROUTER_BASE_URL": "https://openrouter.example/api/v1",
    "BETTERAI_OPENROUTER_API_KEY_FILE": "/data/openrouter-key",
    "BETTERAI_OPENROUTER_EMBEDDING_MODEL": "provider/embed-model",
    "BETTERAI_OPENROUTER_AGENT_MODEL": "provider/judge-model",
    "BETTERAI_PROMPT_IMPROVER_MODEL": "provider/improver-model",
    "BETTERAI_EMBEDDING_DIM": "384",
    "BETTERAI_HYBRID_FUSION": "rrf",
    "BETTERAI_HYBRID_ALPHA": "0.7",
    "BETTERAI_SIMILARITY_THRESHOLD": "0.35",
    "BETTERAI_MAX_CANDIDATES": "100",
    "BETTERAI_EDIT_GRANULARITY": "none",
    "BETTERAI_MEMORY_PROVIDER": "basic-memory",
    "BETTERAI_PLAN_GLOB": "**/.claude/plans/*.md",
    "BETTERAI_COMPOSE_FILE": "/data/docker-compose.yml",
    "BETTERAI_DOCKER_SOCK": "/var/run/docker.sock",
    "BETTERAI_COMMENT_VERBOSITY": "default",
    "BETTERAI_READ_GATE": "on",
    "BETTERAI_RECEIPT_GATE": "on",
    "BETTERAI_REQUIRED_READS_MAX": "5",
    "BETTERAI_SKILLS_REPO_URL": "https://github.test/nicov7/betterai-skills",
    "BETTERAI_SKILLS_SYNC_TTL": "3600",
}


class TestFromEnv:
    def test_full_env_parses_with_typed_fields(self):
        # arrange
        env = dict(FULL_ENV)
        # act
        settings = Settings.from_env(env)
        # assert
        assert settings.mcp_port == 7777
        assert settings.embedding_dim == 384
        assert settings.hybrid_alpha == 0.7
        assert settings.allowed_hosts is None

    def test_empty_env_raises_bai_120_listing_every_key(self):
        # arrange
        env: dict[str, str] = {}
        # act
        with pytest.raises(ConfigMissingError) as excinfo:
            Settings.from_env(env)
        # assert
        for key in REQUIRED_KEYS:
            assert key in str(excinfo.value)
        assert excinfo.value.code == "BAI-120"

    def test_single_missing_key_is_named_exactly(self):
        # arrange
        env = dict(FULL_ENV)
        del env["BETTERAI_REDIS_URL"]
        # act
        with pytest.raises(ConfigMissingError) as excinfo:
            Settings.from_env(env)
        # assert
        assert "BETTERAI_REDIS_URL" in str(excinfo.value)
        assert "BETTERAI_MCP_PORT" not in str(excinfo.value)

    def test_empty_string_counts_as_missing(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_TOKEN_PATH"] = ""
        # act / assert
        with pytest.raises(ConfigMissingError):
            Settings.from_env(env)

    def test_non_integer_port_raises_bai_121(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_MCP_PORT"] = "not-a-port"
        # act
        with pytest.raises(ConfigInvalidError) as excinfo:
            Settings.from_env(env)
        # assert
        assert excinfo.value.code == "BAI-121"
        assert "BETTERAI_MCP_PORT" in str(excinfo.value)

    def test_unknown_granularity_raises_bai_121(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_EDIT_GRANULARITY"] = "paragraph"
        # act / assert
        with pytest.raises(ConfigInvalidError):
            Settings.from_env(env)

    def test_skills_repo_url_rejects_non_https(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_SKILLS_REPO_URL"] = "git@github.test:owner/repo.git"
        # act
        with pytest.raises(ConfigInvalidError) as excinfo:
            Settings.from_env(env)
        # assert
        assert "BETTERAI_SKILLS_REPO_URL" in str(excinfo.value)

    def test_skills_repo_url_off_disables_sync(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_SKILLS_REPO_URL"] = "off"
        # act
        settings = Settings.from_env(env)
        # assert
        assert settings.skills_repo_url == "off"

    def test_allowed_hosts_parses_comma_list(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_ALLOWED_HOSTS"] = "127.0.0.1:7777, localhost:7777"
        # act
        settings = Settings.from_env(env)
        # assert
        assert settings.allowed_hosts == ("127.0.0.1:7777", "localhost:7777")


class TestCommentPolicy:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("default", CommentPolicy("default")),
            ("none", CommentPolicy("none")),
            ("tokens:150", CommentPolicy("tokens", 150)),
            ("lines:2", CommentPolicy("lines", 2)),
        ],
    )
    def test_parses_every_mode(self, raw, expected):
        assert parse_comment_policy(raw) == expected

    @pytest.mark.parametrize(
        "raw", ["", "verbose", "tokens", "tokens:", "tokens:abc", "lines:0", "default:3"]
    )
    def test_malformed_raises_value_error(self, raw):
        with pytest.raises(ValueError):
            parse_comment_policy(raw)

    def test_from_env_wraps_malformed_as_bai_121(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_COMMENT_VERBOSITY"] = "lines:zero"
        # act
        with pytest.raises(ConfigInvalidError) as excinfo:
            Settings.from_env(env)
        # assert
        assert "BETTERAI_COMMENT_VERBOSITY" in str(excinfo.value)

    def test_from_env_parses_budget_mode(self):
        # arrange
        env = dict(FULL_ENV)
        env["BETTERAI_COMMENT_VERBOSITY"] = "tokens:200"
        # act
        settings = Settings.from_env(env)
        # assert
        assert settings.comment_verbosity == CommentPolicy("tokens", 200)
