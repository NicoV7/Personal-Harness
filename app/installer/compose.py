"""Render <home>/.betterai/docker-compose.yml.

WHY dict-building + yaml.safe_dump instead of string templates (the TS
predecessor templated strings): dumping keeps quoting/indentation
correct by construction and lets the memory-provider seam inject a whole
service without string surgery.

Topology: `betterai` is the only service on the edge network and the
only published port (loopback only); redis and postgres live on an
internal-only network. Host bind mounts keep all state under the install
root. The postgres password is interpolated by docker compose from the
same `.env` the installer writes (never a literal in this file).
"""

from __future__ import annotations

import yaml

from app.installer.install_env import (
    BETTERAI_IMAGE,
    DOCKER_SOCK,
    MCP_PORT,
    POSTGRES_IMAGE,
    REDIS_IMAGE,
    betterai_root,
)
from app.installer.memory_provider import memory_provider_wiring

EDGE_NETWORK = "betterai-edge"
INTERNAL_NETWORK = "betterai-internal"


def render_compose(home: str, memory_provider: str) -> str:
    root = betterai_root(home)
    services = {
        "betterai": _betterai_service(root),
        "redis": _redis_service(root),
        "postgres": _postgres_service(root),
    }
    memory_service, _ = memory_provider_wiring(memory_provider, home)
    if memory_service is not None:
        services[memory_provider] = memory_service
    document = {
        "services": services,
        "networks": {EDGE_NETWORK: {}, INTERNAL_NETWORK: {"internal": True}},
    }
    return yaml.safe_dump(document, sort_keys=False)


def _betterai_service(root: str) -> dict:
    # docker.sock is mounted read-only so start_container can drive
    # compose for this file only -- documented tradeoff (plan, Risks).
    return {
        "image": BETTERAI_IMAGE,
        "networks": [EDGE_NETWORK, INTERNAL_NETWORK],
        "ports": [f"127.0.0.1:{MCP_PORT}:{MCP_PORT}"],
        "volumes": [f"{root}:/data:rw", f"{DOCKER_SOCK}:{DOCKER_SOCK}:ro"],
        "env_file": [".env"],
        "depends_on": {
            "redis": {"condition": "service_healthy"},
            "postgres": {"condition": "service_healthy"},
        },
        "healthcheck": {
            "test": ["CMD", "python", "-c", _HEALTH_PROBE],
            "interval": "30s",
            "timeout": "3s",
            "retries": 3,
            "start_period": "15s",
        },
        "restart": "unless-stopped",
    }


_HEALTH_PROBE = (
    "import sys, urllib.request; "
    f"sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:{MCP_PORT}/health')"
    ".status == 200 else 1)"
)


def _redis_service(root: str) -> dict:
    # RDB snapshotting (save 60s/1 change) per locked decision 2.
    return {
        "image": REDIS_IMAGE,
        "command": ["redis-server", "--save", "60", "1"],
        "volumes": [f"{root}/redis:/data:rw"],
        "healthcheck": {
            "test": ["CMD", "redis-cli", "ping"],
            "interval": "10s",
            "timeout": "3s",
            "retries": 5,
        },
        "networks": [INTERNAL_NETWORK],
        "restart": "unless-stopped",
    }


def _postgres_service(root: str) -> dict:
    return {
        "image": POSTGRES_IMAGE,
        "environment": {
            "POSTGRES_USER": "betterai",
            "POSTGRES_DB": "betterai",
            "POSTGRES_PASSWORD": "${BETTERAI_POSTGRES_PASSWORD}",
        },
        "volumes": [f"{root}/postgres:/var/lib/postgresql/data:rw"],
        "healthcheck": {
            "test": ["CMD-SHELL", "pg_isready -U betterai -d betterai"],
            "interval": "10s",
            "timeout": "3s",
            "retries": 5,
        },
        "networks": [INTERNAL_NETWORK],
        "restart": "unless-stopped",
    }
