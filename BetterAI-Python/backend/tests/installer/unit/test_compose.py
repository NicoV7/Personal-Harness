"""Compose rendering: 3 pinned services, loopback-only publishing,
internal data plane, and the memory-provider seam variants."""

from __future__ import annotations

import pytest
import yaml

from app.errors import ConfigInvalidError
from app.installer.compose import render_compose
from app.installer.memory_provider import memory_provider_wiring

HOME = "/home/fixture"


def test_renders_exactly_three_services_without_memory_provider() -> None:
    # arrange / act
    document = yaml.safe_load(render_compose(HOME, "none"))
    # assert
    assert sorted(document["services"]) == ["betterai", "postgres", "redis"]
    assert document["networks"]["betterai-internal"] == {"internal": True}


def test_betterai_service_publishes_loopback_only_and_mounts_sock_readonly() -> None:
    # arrange / act
    services = yaml.safe_load(render_compose(HOME, "none"))["services"]
    # assert
    betterai = services["betterai"]
    assert betterai["ports"] == ["127.0.0.1:7777:7777"]
    assert f"{HOME}/.betterai:/data:rw" in betterai["volumes"]
    assert "/var/run/docker.sock:/var/run/docker.sock:ro" in betterai["volumes"]
    assert betterai["depends_on"]["redis"]["condition"] == "service_healthy"
    assert betterai["depends_on"]["postgres"]["condition"] == "service_healthy"
    assert services["redis"]["networks"] == ["betterai-internal"]
    assert services["postgres"]["networks"] == ["betterai-internal"]


def test_postgres_password_is_interpolated_from_env_not_literal() -> None:
    # arrange / act
    rendered = render_compose(HOME, "none")
    # assert
    postgres = yaml.safe_load(rendered)["services"]["postgres"]
    assert postgres["environment"]["POSTGRES_PASSWORD"] == "${BETTERAI_POSTGRES_PASSWORD}"
    assert postgres["image"].startswith("pgvector/pgvector:")
    assert yaml.safe_load(rendered)["services"]["redis"]["image"] == "redis:8.8"


def test_basic_memory_variant_adds_a_fourth_service_on_8010() -> None:
    # arrange / act
    services = yaml.safe_load(render_compose(HOME, "basic-memory"))["services"]
    # assert
    assert "basic-memory" in services
    assert services["basic-memory"]["ports"] == ["127.0.0.1:8010:8000"]
    assert services["basic-memory"]["image"].startswith("ghcr.io/basicmachines-co/basic-memory")


def test_cognee_variant_adds_a_cognee_service() -> None:
    # arrange / act
    services = yaml.safe_load(render_compose(HOME, "cognee"))["services"]
    # assert
    assert "cognee" in services
    assert len(services) == 4


def test_provider_seam_returns_nothing_for_none_and_fails_loud_on_unknown() -> None:
    # arrange / act
    wiring = memory_provider_wiring("none", HOME)
    # assert
    assert wiring == (None, None)
    with pytest.raises(ConfigInvalidError):
        memory_provider_wiring("mem0", HOME)


def test_provider_registrations_never_contain_credentials() -> None:
    # arrange / act
    _, registration = memory_provider_wiring("basic-memory", HOME)
    # assert
    assert registration is not None
    assert registration["url"] == "http://127.0.0.1:8010/sse"
    assert "token" not in str(registration).lower()
