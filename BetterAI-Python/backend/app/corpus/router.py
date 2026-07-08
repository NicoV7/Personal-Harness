"""Domain router: rules/_meta/domain-router.yaml -> domains to retrieve.

Port of src/retrieval/router.ts onto pyyaml. The TS mini-YAML parser
silently dropped flat top-level keys (docs/HANDOFF.md Wave-6 follow-up),
so routing always fell back to the built-in default domains — parsing
with a real YAML library is the fix. Semantics are kept identical to the
TS original: routers UNION their domain sets, per-domain and total caps
come from `defaults`, and the fallback domains apply only when no router
fires. A malformed config file fails loud (the TS parser could not),
because silently routing on defaults is exactly the bug this port fixes.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import yaml

from app.errors import Errors

# Fallback budget when no config file exists or the `defaults` key is
# absent. These mirror the TS constants — they are routing-spec fallbacks
# (documented in rules/_meta/domain-router.yaml), not hidden env defaults.
DEFAULT_ROUTER_DOMAINS = ("maintainability", "methodology")
DEFAULT_MAX_RULES_PER_DOMAIN = 4
DEFAULT_MAX_TOTAL_RULES = 12


@dataclass(frozen=True)
class RouteResult:
    domains: tuple[str, ...]
    max_rules_per_domain: int
    max_total_rules: int
    # Which router ids actually fired, for diagnostics/audit.
    fired: tuple[str, ...]


class DomainRouter:
    """Routes an intent + file paths to rule DOMAINS (never to ids —
    domains are stable, ids churn; per the v4 distributed-routing design)."""

    def __init__(self, config: dict) -> None:
        self._routers = list(config.get("routers") or [])
        defaults = dict(config.get("defaults") or {})
        self._default_domains = tuple(defaults.get("domains") or DEFAULT_ROUTER_DOMAINS)
        per_domain = defaults.get("max_rules_per_domain")
        total = defaults.get("max_total_rules")
        # `is None` (not `or`) so an author's explicit 0 is honored.
        self._max_rules_per_domain = (
            DEFAULT_MAX_RULES_PER_DOMAIN if per_domain is None else int(per_domain)
        )
        self._max_total_rules = DEFAULT_MAX_TOTAL_RULES if total is None else int(total)

    @classmethod
    def from_file(cls, path: str) -> DomainRouter:
        config_path = Path(path)
        if not config_path.exists():
            # No router config is a valid state (fresh corpus): route on
            # the documented fallback budget, matching the TS behavior.
            return cls({})
        try:
            loaded = yaml.safe_load(config_path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise Errors.artifact_invalid(
                path, f"router config is not valid YAML: {exc}"
            ) from exc
        if loaded is None:
            loaded = {}
        if not isinstance(loaded, dict):
            raise Errors.artifact_invalid(path, "router config must be a YAML mapping")
        return cls(loaded)

    def route(self, intent: str, file_paths: Sequence[str] | None = None) -> RouteResult:
        paths = list(file_paths or [])
        intent_lc = intent.lower()
        domains: dict[str, None] = {}
        fired: list[str] = []
        for router in self._routers:
            matched = _router_domains(router, intent_lc, paths)
            if not matched:
                continue
            fired.append(str(router.get("id", "")))
            domains.update(dict.fromkeys(matched))
        if not domains:
            domains = dict.fromkeys(self._default_domains)
        return RouteResult(
            domains=tuple(domains),
            max_rules_per_domain=self._max_rules_per_domain,
            max_total_rules=self._max_total_rules,
            fired=tuple(fired),
        )

    @property
    def defaults(self) -> RouteResult:
        return RouteResult(
            domains=self._default_domains,
            max_rules_per_domain=self._max_rules_per_domain,
            max_total_rules=self._max_total_rules,
            fired=(),
        )


def _router_domains(router: dict, intent_lc: str, paths: list[str]) -> list[str]:
    matched: list[str] = []
    for rule in router.get("rules") or []:
        if _rule_matches(rule, intent_lc, paths):
            matched.extend(rule.get("domains") or [])
    return matched


def _rule_matches(rule: dict, intent_lc: str, paths: list[str]) -> bool:
    glob = rule.get("if_match")
    if glob and any(glob_to_regex(glob).match(path) for path in paths):
        return True
    keywords = rule.get("if_intent_contains") or []
    return any(str(keyword).lower() in intent_lc for keyword in keywords)


def glob_to_regex(glob: str) -> re.Pattern[str]:
    """`**` crosses directories, `*` and `?` stay within one segment —
    the same subset the TS router supported (no braces, no extglob)."""
    out = ["^"]
    i = 0
    while i < len(glob):
        char = glob[i]
        if char == "*" and glob[i + 1 : i + 2] == "*":
            out.append(".*")
            i += 2
            if glob[i : i + 1] == "/":
                i += 1
            continue
        if char == "*":
            out.append("[^/]*")
        elif char == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(char))
        i += 1
    out.append("$")
    return re.compile("".join(out))
