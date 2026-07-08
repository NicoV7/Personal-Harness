"""install_env_values is the ONE home for generation-time values: it
must cover every required runtime key with a concrete value and never
emit a placeholder."""

from __future__ import annotations

import pytest

from app.errors import ConfigMissingError
from app.installer.install_env import install_env_values
from app.settings import REQUIRED_KEYS

JUDGE_OVERRIDE = {"BETTERAI_OPENROUTER_AGENT_MODEL": "vendor/test-judge-model"}
PLACEHOLDER_MARKERS = ("set_me", "changeme", "todo", "replace", "placeholder", "<", ">", "example.com")


def test_generated_env_contains_every_required_settings_key() -> None:
    # arrange / act
    values = install_env_values("/home/fixture", overrides=JUDGE_OVERRIDE)
    # assert
    missing = [key for key in REQUIRED_KEYS if key not in values]
    assert missing == []
    assert all(values[key] for key in REQUIRED_KEYS)


def test_generated_env_has_no_placeholder_values() -> None:
    # arrange / act
    values = install_env_values("/home/fixture", overrides=JUDGE_OVERRIDE)
    # assert
    for key, value in values.items():
        lowered = value.lower()
        hits = [marker for marker in PLACEHOLDER_MARKERS if marker in lowered]
        assert hits == [], f"{key} looks like a placeholder: {value!r}"


def test_postgres_password_is_generated_per_install_and_embedded_in_dsn() -> None:
    # arrange / act
    first = install_env_values("/home/fixture", overrides=JUDGE_OVERRIDE)
    second = install_env_values("/home/fixture", overrides=JUDGE_OVERRIDE)
    # assert
    password = first["BETTERAI_POSTGRES_PASSWORD"]
    assert len(password) >= 24
    assert password in first["BETTERAI_POSTGRES_DSN"]
    assert password != second["BETTERAI_POSTGRES_PASSWORD"]


def test_missing_judge_model_fails_loud_instead_of_guessing() -> None:
    # arrange / act / assert
    with pytest.raises(ConfigMissingError) as excinfo:
        install_env_values("/home/fixture")
    assert "BETTERAI_OPENROUTER_AGENT_MODEL" in str(excinfo.value)


def test_cli_overrides_win_over_generated_values() -> None:
    # arrange
    overrides = dict(JUDGE_OVERRIDE)
    overrides["BETTERAI_EDIT_GRANULARITY"] = "function"
    overrides["BETTERAI_MEMORY_PROVIDER"] = "basic-memory"
    # act
    values = install_env_values("/home/fixture", overrides=overrides)
    # assert
    assert values["BETTERAI_EDIT_GRANULARITY"] == "function"
    assert values["BETTERAI_MEMORY_PROVIDER"] == "basic-memory"
