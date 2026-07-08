"""Corpus reader: markdown + YAML frontmatter -> validated Artifacts.

Validation lives in this one walk because retrieval, the read gate, and
edit_skill all consume the same Artifact model — a file that parses here
is indexable and servable everywhere. Invalid files fail loud (BAI-410)
instead of being skipped: a silently dropped rule is a harness lying
about its own corpus. Memories are the single lenient exception — they
are deprecated and parsed ONLY for `export-memories`.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import yaml
from pydantic import ValidationError

from app.corpus.schema import Artifact, Memory, Scope
from app.errors import ArtifactInvalidError, Errors

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)\Z", re.DOTALL)

# Directory name -> artifact type. The directory is authoritative over
# any `artifact_type` frontmatter key (the TS-era corpus files carry none).
_ARTIFACT_TYPE_DIRS = (("rules", "rule"), ("skills", "skill"))


class CorpusReader:
    """Walks the global root and (optionally) a repo root, stamping scope
    from which root a file lives under. On id collision the repo artifact
    replaces the global one (rules/_meta/conflict-resolution.md); the
    dropped global ids are echoed via overridden_global_ids()."""

    def __init__(self, global_root: str, repo_root: str | None = None) -> None:
        self.global_root = global_root
        self.repo_root = repo_root
        self._overridden: list[str] | None = None

    def read(self) -> list[Artifact]:
        """Fresh walk on every call: the filesystem is the system of
        record and caching here would create a second source of truth."""
        global_artifacts = _read_root(self.global_root, "global")
        repo_artifacts = _read_root(self.repo_root, "repo") if self.repo_root else []
        merged, overridden = _merge_repo_over_global(global_artifacts, repo_artifacts)
        self._overridden = overridden
        return merged

    def find(self, artifact_id: str) -> Artifact | None:
        for artifact in self.read():
            if artifact.id == artifact_id:
                return artifact
        return None

    def overridden_global_ids(self) -> list[str]:
        if self._overridden is None:
            self.read()
        return list(self._overridden or [])

    def read_memories(self) -> list[Memory]:
        """Deprecated memories, parsed ONLY for `export-memories`.
        Lenient by design (see schema.Memory): an export must not die on
        legacy field drift in files that are leaving the system."""
        roots: list[tuple[str, Scope]] = [(self.global_root, "global")]
        if self.repo_root:
            roots.append((self.repo_root, "repo"))
        memories: list[Memory] = []
        for root, scope in roots:
            memories.extend(_memories_under(Path(root) / "memories", scope))
        return memories


def _read_root(root: str, scope: Scope) -> list[Artifact]:
    artifacts: list[Artifact] = []
    for dir_name, artifact_type_name in _ARTIFACT_TYPE_DIRS:
        for path in _walk_markdown(Path(root) / dir_name):
            artifacts.append(_load_artifact(path, artifact_type_name, scope))
    return artifacts


def _walk_markdown(directory: Path) -> list[Path]:
    """Every .md under `directory`, `_meta` trees pruned, sorted for a
    deterministic corpus order regardless of filesystem."""
    if not directory.is_dir():
        return []
    found: list[Path] = []
    for current, dir_names, file_names in os.walk(directory):
        dir_names[:] = sorted(name for name in dir_names if name != "_meta")
        found.extend(
            Path(current) / name for name in sorted(file_names) if name.endswith(".md")
        )
    return found


def _load_artifact(path: Path, artifact_type_name: str, scope: Scope) -> Artifact:
    raw = path.read_text(encoding="utf-8")
    frontmatter, body = _split_frontmatter(path, raw)
    frontmatter.update(
        artifact_type=artifact_type_name,
        scope=scope,
        source_path=str(path),
        content_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        body=body,
    )
    try:
        return Artifact(**frontmatter)
    except ValidationError as exc:
        raise Errors.artifact_invalid(str(path), _validation_summary(exc)) from exc


def _split_frontmatter(path: Path, raw: str) -> tuple[dict, str]:
    match = _FRONTMATTER_RE.match(raw)
    if match is None:
        raise Errors.artifact_invalid(str(path), "no frontmatter block found")
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise Errors.artifact_invalid(
            str(path), f"frontmatter is not valid YAML: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise Errors.artifact_invalid(str(path), "frontmatter is not a YAML mapping")
    return data, match.group(2)


def _validation_summary(exc: ValidationError) -> str:
    issues = (
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
        for error in exc.errors()
    )
    return f"frontmatter invalid: {'; '.join(issues)}"


def _merge_repo_over_global(
    global_items: list[Artifact], repo_items: list[Artifact]
) -> tuple[list[Artifact], list[str]]:
    repo_ids = {artifact.id for artifact in repo_items}
    overridden = [artifact.id for artifact in global_items if artifact.id in repo_ids]
    surviving = [artifact for artifact in global_items if artifact.id not in repo_ids]
    return [*surviving, *repo_items], overridden


def _memories_under(directory: Path, scope: Scope) -> list[Memory]:
    parsed = (_load_memory(path, scope) for path in _walk_markdown(directory))
    return [memory for memory in parsed if memory is not None]


def _load_memory(path: Path, scope: Scope) -> Memory | None:
    raw = path.read_text(encoding="utf-8")
    try:
        frontmatter, body = _split_frontmatter(path, raw)
        return Memory(**{**frontmatter, "scope": scope, "source_path": str(path), "body": body})
    except (ArtifactInvalidError, ValidationError):
        return None
