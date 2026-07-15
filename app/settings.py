"""Runtime configuration. Every key is required — there are NO defaults.

A missing key crashes boot with BAI-120 listing exactly what is absent
(config-explicit-no-defaults). Generation-time values live in the
installer (`app/installer/install_env.py`), which writes them into the
user-visible `.env`; nothing is silently applied at runtime.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from app.errors import Errors

EDIT_GRANULARITIES = ("function", "file", "none")
HYBRID_FUSIONS = ("linear", "rrf")
MEMORY_PROVIDERS = ("basic-memory", "cognee", "none")
COMMENT_MODES = ("default", "none", "tokens", "lines")

REQUIRED_KEYS = (
    "BETTERAI_CORPUS_ROOT",
    "BETTERAI_AUDIT_PATH",
    "BETTERAI_BIND_HOST",
    "BETTERAI_MCP_PORT",
    "BETTERAI_TOKEN_PATH",
    "BETTERAI_REDIS_URL",
    "BETTERAI_POSTGRES_DSN",
    "BETTERAI_OPENROUTER_BASE_URL",
    "BETTERAI_OPENROUTER_API_KEY_FILE",
    "BETTERAI_OPENROUTER_EMBEDDING_MODEL",
    "BETTERAI_OPENROUTER_AGENT_MODEL",
    "BETTERAI_PROMPT_IMPROVER_MODEL",
    "BETTERAI_EMBEDDING_DIM",
    "BETTERAI_HYBRID_FUSION",
    "BETTERAI_HYBRID_ALPHA",
    "BETTERAI_SIMILARITY_THRESHOLD",
    "BETTERAI_MAX_CANDIDATES",
    "BETTERAI_EDIT_GRANULARITY",
    "BETTERAI_MEMORY_PROVIDER",
    "BETTERAI_PLAN_GLOB",
    "BETTERAI_COMPOSE_FILE",
    "BETTERAI_DOCKER_SOCK",
    "BETTERAI_COMMENT_VERBOSITY",
)

# Present-but-unset is allowed only for keys whose absence is a meaningful
# state, never a hidden default. BETTERAI_ALLOWED_HOSTS unset means "derive
# from bind host + port".
OPTIONAL_KEYS = ("BETTERAI_ALLOWED_HOSTS",)


@dataclass(frozen=True)
class CommentPolicy:
    """Comment-verbosity directive injected into every prompt's context.

    mode "default" injects nothing; "none" bans new comments; "tokens" /
    "lines" carry an integer budget in `limit`.
    """

    mode: str
    limit: int | None = None


def parse_comment_policy(raw: str) -> CommentPolicy:
    """Parse 'default' | 'none' | 'tokens:<int>' | 'lines:<int>'.

    Raises ValueError so callers decide the typed error (settings wraps
    into BAI-121; the hook layer treats a bad skill setting the same way).
    """
    mode, _, argument = raw.strip().partition(":")
    if mode not in COMMENT_MODES:
        raise ValueError(f"expected one of {COMMENT_MODES}, got {raw!r}")
    if mode in ("default", "none"):
        if argument:
            raise ValueError(f"{mode!r} takes no argument, got {raw!r}")
        return CommentPolicy(mode=mode)
    if not argument.isdigit() or int(argument) < 1:
        raise ValueError(f"{mode!r} needs a positive integer argument, got {raw!r}")
    return CommentPolicy(mode=mode, limit=int(argument))


@dataclass(frozen=True)
class Settings:
    corpus_root: str
    audit_path: str
    bind_host: str
    mcp_port: int
    token_path: str
    allowed_hosts: tuple[str, ...] | None
    redis_url: str
    postgres_dsn: str
    openrouter_base_url: str
    openrouter_api_key_file: str
    openrouter_embedding_model: str
    openrouter_agent_model: str
    prompt_improver_model: str  # "off" disables prompt expansion explicitly
    embedding_dim: int
    hybrid_fusion: str
    hybrid_alpha: float
    similarity_threshold: float
    max_candidates: int
    edit_granularity: str
    memory_provider: str
    plan_glob: str
    compose_file: str
    docker_sock: str
    comment_verbosity: CommentPolicy

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        missing = [key for key in REQUIRED_KEYS if not env.get(key)]
        if missing:
            raise Errors.config_missing(missing)
        return cls(
            corpus_root=env["BETTERAI_CORPUS_ROOT"],
            audit_path=env["BETTERAI_AUDIT_PATH"],
            bind_host=env["BETTERAI_BIND_HOST"],
            mcp_port=_int(env, "BETTERAI_MCP_PORT"),
            token_path=env["BETTERAI_TOKEN_PATH"],
            allowed_hosts=_hosts(env.get("BETTERAI_ALLOWED_HOSTS")),
            redis_url=env["BETTERAI_REDIS_URL"],
            postgres_dsn=env["BETTERAI_POSTGRES_DSN"],
            openrouter_base_url=env["BETTERAI_OPENROUTER_BASE_URL"],
            openrouter_api_key_file=env["BETTERAI_OPENROUTER_API_KEY_FILE"],
            openrouter_embedding_model=env["BETTERAI_OPENROUTER_EMBEDDING_MODEL"],
            openrouter_agent_model=env["BETTERAI_OPENROUTER_AGENT_MODEL"],
            prompt_improver_model=env["BETTERAI_PROMPT_IMPROVER_MODEL"],
            embedding_dim=_int(env, "BETTERAI_EMBEDDING_DIM"),
            hybrid_fusion=_choice(env, "BETTERAI_HYBRID_FUSION", HYBRID_FUSIONS),
            hybrid_alpha=_float(env, "BETTERAI_HYBRID_ALPHA"),
            similarity_threshold=_unit_interval(env, "BETTERAI_SIMILARITY_THRESHOLD"),
            max_candidates=_int(env, "BETTERAI_MAX_CANDIDATES"),
            edit_granularity=_choice(env, "BETTERAI_EDIT_GRANULARITY", EDIT_GRANULARITIES),
            memory_provider=_choice(env, "BETTERAI_MEMORY_PROVIDER", MEMORY_PROVIDERS),
            plan_glob=env["BETTERAI_PLAN_GLOB"],
            compose_file=env["BETTERAI_COMPOSE_FILE"],
            docker_sock=env["BETTERAI_DOCKER_SOCK"],
            comment_verbosity=_comment_policy(env, "BETTERAI_COMMENT_VERBOSITY"),
        )


def _int(env: Mapping[str, str], key: str) -> int:
    raw = env[key]
    try:
        return int(raw)
    except ValueError as exc:
        raise Errors.config_invalid(key, f"expected integer, got {raw!r}") from exc


def _float(env: Mapping[str, str], key: str) -> float:
    raw = env[key]
    try:
        return float(raw)
    except ValueError as exc:
        raise Errors.config_invalid(key, f"expected number, got {raw!r}") from exc


def _unit_interval(env: Mapping[str, str], key: str) -> float:
    value = _float(env, key)
    if not 0.0 <= value <= 1.0:
        raise Errors.config_invalid(key, f"expected a value in [0, 1], got {value}")
    return value


def _choice(env: Mapping[str, str], key: str, allowed: tuple[str, ...]) -> str:
    raw = env[key]
    if raw not in allowed:
        raise Errors.config_invalid(key, f"expected one of {allowed}, got {raw!r}")
    return raw


def _comment_policy(env: Mapping[str, str], key: str) -> CommentPolicy:
    try:
        return parse_comment_policy(env[key])
    except ValueError as exc:
        raise Errors.config_invalid(key, str(exc)) from exc


def _hosts(raw: str | None) -> tuple[str, ...] | None:
    if raw is None or raw.strip() == "":
        return None
    return tuple(host.strip() for host in raw.split(",") if host.strip())
