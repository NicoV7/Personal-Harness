"""DomainRouter: pyyaml-backed port of the TS routing semantics."""

from __future__ import annotations

import pytest

from app.corpus.router import (
    DEFAULT_MAX_RULES_PER_DOMAIN,
    DEFAULT_MAX_TOTAL_RULES,
    DEFAULT_ROUTER_DOMAINS,
    DomainRouter,
)
from app.errors import ArtifactInvalidError

CONFIG = """
routers:
  - id: by-path-glob
    rules:
      - if_match: "**/*.py"
        domains: [maintainability, error-handling]
      - if_match: "**/auth/**"
        domains: [security, error-handling]
  - id: by-intent-keyword
    rules:
      - if_intent_contains: ["plan", "design"]
        domains: [methodology, structure]
defaults:
  domains: [maintainability, methodology]
  max_rules_per_domain: 3
  max_total_rules: 9
"""


@pytest.fixture
def router(tmp_path):
    path = tmp_path / "domain-router.yaml"
    path.write_text(CONFIG, encoding="utf-8")
    return DomainRouter.from_file(str(path))


class TestRoute:
    def test_intent_keyword_routes_domains_and_reports_fired(self, router):
        # arrange / act
        result = router.route("plan the migration")
        # assert
        assert result.domains == ("methodology", "structure")
        assert result.fired == ("by-intent-keyword",)

    def test_path_glob_matches_across_directories(self, router):
        # arrange / act
        result = router.route("", file_paths=["src/app/deep/module.py"])
        # assert
        assert result.domains == ("maintainability", "error-handling")
        assert result.fired == ("by-path-glob",)

    def test_multiple_routers_union_domains_without_duplicates(self, router):
        # arrange / act
        result = router.route("design the login flow", file_paths=["src/auth/token.py"])
        # assert (error-handling appears once despite two matching rules)
        assert result.domains == (
            "maintainability",
            "error-handling",
            "security",
            "methodology",
            "structure",
        )
        assert set(result.fired) == {"by-path-glob", "by-intent-keyword"}

    def test_no_match_falls_back_to_config_defaults(self, router):
        # arrange / act
        result = router.route("completely unrelated request")
        # assert
        assert result.domains == ("maintainability", "methodology")
        assert result.fired == ()
        assert result.max_rules_per_domain == 3
        assert result.max_total_rules == 9


class TestFromFile:
    def test_missing_file_routes_on_builtin_fallback_budget(self, tmp_path):
        # arrange
        router = DomainRouter.from_file(str(tmp_path / "absent.yaml"))
        # act
        result = router.route("anything")
        # assert
        assert result.domains == DEFAULT_ROUTER_DOMAINS
        assert result.max_rules_per_domain == DEFAULT_MAX_RULES_PER_DOMAIN
        assert result.max_total_rules == DEFAULT_MAX_TOTAL_RULES

    def test_malformed_yaml_fails_loud(self, tmp_path):
        # arrange
        path = tmp_path / "domain-router.yaml"
        path.write_text("routers: [unclosed", encoding="utf-8")
        # act / assert
        with pytest.raises(ArtifactInvalidError):
            DomainRouter.from_file(str(path))

    def test_non_mapping_config_fails_loud(self, tmp_path):
        # arrange
        path = tmp_path / "domain-router.yaml"
        path.write_text("- just\n- a\n- list\n", encoding="utf-8")
        # act / assert
        with pytest.raises(ArtifactInvalidError):
            DomainRouter.from_file(str(path))
