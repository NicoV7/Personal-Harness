"""Generation-time configuration values: the ONE home for them.

WHY this module exists: the runtime Settings layer has zero defaults --
a missing key crashes boot with BAI-120. Every concrete value therefore
must be minted exactly once, at install time, and written into the
user-visible `.env`. Nothing else in the codebase invents config values.

Two values are deliberately NOT minted here, because guessing them would
be a silent default in disguise:

- ``BETTERAI_OPENROUTER_AGENT_MODEL`` (the eval judge model): the CLI
  requires ``--judge-model`` (or its interactive prompt) and passes it
  through ``overrides``. Absent -> BAI-120. No placeholder ever lands in
  a generated `.env`.
- the OpenRouter API key: the CLI requires ``--openrouter-key-file`` and
  copies the key to ``<home>/.betterai/openrouter-key`` (0600); the env
  only names the in-container path to that file.

Paths in the returned mapping are container paths, because the `.env`
is the container's env_file: ``<home>/.betterai`` on the host mounts at
``/data`` in-container (so the model cache ``<home>/.betterai/models``
is ``/data/models``, the compose file is ``/data/docker-compose.yml``).
``BETTERAI_POSTGRES_PASSWORD`` is extra (not in REQUIRED_KEYS): docker
compose interpolates it into the postgres service from the same `.env`.
"""

from __future__ import annotations

import secrets
from pathlib import Path

from app.errors import Errors
from app.settings import REQUIRED_KEYS

BETTERAI_IMAGE = "ghcr.io/nicov7/personal-harness-py:0.4.1"
SUPERGATEWAY_IMAGE = "supercorp/supergateway:3.4.3"
REDIS_IMAGE = "redis:8.8"
POSTGRES_IMAGE = "pgvector/pgvector:0.8.4-pg17-bookworm"
MCP_PORT = 7777
# Host clients use to reach the published server port (compose publishes
# 127.0.0.1 only); this module is the one sanctioned home for the literal.
SERVER_HOST = "127.0.0.1"
DOCKER_SOCK = "/var/run/docker.sock"
CONTAINER_DATA = "/data"


def betterai_root(home: str) -> str:
    """Host-side install root; mounted at CONTAINER_DATA in the container."""
    return str(Path(home) / ".betterai")


def install_env_values(home: str, overrides: dict | None = None) -> dict[str, str]:
    """Return the complete env mapping the installer writes to `.env`.

    Raises BAI-120 when a required key has no concrete value after
    overrides are applied (by construction that is only the judge model,
    unless a caller override blanks something out).
    """
    del home  # container paths are fixed; kept in the signature for the seam
    password = secrets.token_urlsafe(24)
    values: dict[str, str] = {
        "BETTERAI_CORPUS_ROOT": CONTAINER_DATA,
        "BETTERAI_AUDIT_PATH": f"{CONTAINER_DATA}/audit/audit.jsonl",
        "BETTERAI_BIND_HOST": "0.0.0.0",
        "BETTERAI_MCP_PORT": str(MCP_PORT),
        "BETTERAI_TOKEN_PATH": f"{CONTAINER_DATA}/token",
        "BETTERAI_ALLOWED_HOSTS": ",".join(
            f"{host}:{MCP_PORT}"
            for host in ("127.0.0.1", "localhost", "host.docker.internal")
        ),
        "BETTERAI_REDIS_URL": "redis://redis:6379",
        "BETTERAI_POSTGRES_PASSWORD": password,
        "BETTERAI_POSTGRES_DSN": f"postgresql://betterai:{password}@postgres:5432/betterai",
        "BETTERAI_OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
        "BETTERAI_OPENROUTER_API_KEY_FILE": f"{CONTAINER_DATA}/openrouter-key",
        "BETTERAI_OPENROUTER_EMBEDDING_MODEL": "openai/text-embedding-3-small",
        "BETTERAI_EMBEDDING_DIM": "1536",
        "BETTERAI_HYBRID_FUSION": "rrf",
        "BETTERAI_HYBRID_ALPHA": "0.7",
        "BETTERAI_SIMILARITY_THRESHOLD": "0.35",
        "BETTERAI_MAX_CANDIDATES": "100",
        "BETTERAI_EDIT_GRANULARITY": "none",
        "BETTERAI_MEMORY_PROVIDER": "none",
        "BETTERAI_PLAN_GLOB": "**/.claude/plans/*.md",
        "BETTERAI_COMPOSE_FILE": f"{CONTAINER_DATA}/docker-compose.yml",
        "BETTERAI_DOCKER_SOCK": DOCKER_SOCK,
        "BETTERAI_COMMENT_VERBOSITY": "default",
        "BETTERAI_READ_GATE": "on",
        "BETTERAI_REQUIRED_READS_MAX": "5",
    }
    values.update(overrides or {})
    if not values.get("BETTERAI_PROMPT_IMPROVER_MODEL"):
        # Generation-time derivation (sanctioned here, never at runtime):
        # the prompt improver reuses the judge model unless the installer
        # was told otherwise; "off" disables expansion explicitly.
        values["BETTERAI_PROMPT_IMPROVER_MODEL"] = values.get(
            "BETTERAI_OPENROUTER_AGENT_MODEL", ""
        )
    missing = [key for key in REQUIRED_KEYS if not values.get(key)]
    if missing:
        raise Errors.config_missing(missing)
    return values
