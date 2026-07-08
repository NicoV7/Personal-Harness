"""Memory-provider seam (locked decision 11): swapping providers is
config, not code.

WHY a seam: memories were deprecated from the MCP surface and delegated
to an OSS provider chosen per docs/proposals/memory-tool-selection.md
(basic-memory selected, cognee documented fallback). Everything the rest
of the installer needs -- the compose service block and the client-side
MCP registration -- comes from this one function, so flipping
``BETTERAI_MEMORY_PROVIDER`` re-wires the install without touching
compose or adapter code.

Known gap for the integration agent: the cognee-mcp image tag is not
pinned in the P0-R1 proposal (only basic-memory is); ``COGNEE_IMAGE``
below is the upstream repo's published name and must be verified before
`--with-memory cognee` ships.
"""

from __future__ import annotations

from app.errors import Errors
from app.installer.install_env import betterai_root
from app.settings import MEMORY_PROVIDERS

BASIC_MEMORY_IMAGE = "ghcr.io/basicmachines-co/basic-memory:latest"
COGNEE_IMAGE = "cognee/cognee-mcp:main"
BASIC_MEMORY_HOST_PORT = 8010
COGNEE_HOST_PORT = 8020
EDGE_NETWORK = "betterai-edge"


def memory_provider_wiring(
    provider: str, home: str
) -> tuple[dict | None, dict | None]:
    """Return (compose_service_dict, client_mcp_registration) for the
    selected provider; (None, None) when memories are off."""
    if provider == "none":
        return (None, None)
    if provider == "basic-memory":
        return (_basic_memory_service(home), _basic_memory_registration())
    if provider == "cognee":
        return (_cognee_service(home), _cognee_registration())
    raise Errors.config_invalid(
        "BETTERAI_MEMORY_PROVIDER",
        f"expected one of {MEMORY_PROVIDERS}, got {provider!r}",
    )


def _basic_memory_service(home: str) -> dict:
    # Bind mounts (not named volumes) keep every byte under the install
    # root, matching the other services and making uninstall a single rm.
    root = betterai_root(home)
    return {
        "image": BASIC_MEMORY_IMAGE,
        "command": [
            "basic-memory",
            "mcp",
            "--transport",
            "sse",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
        ],
        "ports": [f"127.0.0.1:{BASIC_MEMORY_HOST_PORT}:8000"],
        "volumes": [
            f"{root}/memories-bm:/app/data:rw",
            f"{root}/memories-bm-config:/home/appuser/.basic-memory:rw",
        ],
        "environment": {
            "BASIC_MEMORY_DEFAULT_PROJECT": "betterai",
            "BASIC_MEMORY_SYNC_CHANGES": "true",
        },
        "networks": [EDGE_NETWORK],
        "restart": "unless-stopped",
    }


def _basic_memory_registration() -> dict:
    return {
        "name": "basic-memory",
        "transport": "sse",
        "url": f"http://127.0.0.1:{BASIC_MEMORY_HOST_PORT}/sse",
    }


def _cognee_service(home: str) -> dict:
    root = betterai_root(home)
    return {
        "image": COGNEE_IMAGE,
        "ports": [f"127.0.0.1:{COGNEE_HOST_PORT}:8000"],
        "volumes": [f"{root}/cognee:/app/data:rw"],
        "networks": [EDGE_NETWORK],
        "restart": "unless-stopped",
    }


def _cognee_registration() -> dict:
    return {
        "name": "cognee",
        "transport": "http",
        "url": f"http://127.0.0.1:{COGNEE_HOST_PORT}/mcp",
    }
