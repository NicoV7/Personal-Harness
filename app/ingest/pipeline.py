"""Ingest pipeline: fetch -> extract -> chunk -> distill -> write+index.

Write order per artifact is file-first (corpus markdown is the system of
record) and reindex-second, with the same recovery message as edit_skill:
if indexing fails the file survives and `betterai index` catches the
derived stores up. Artifacts land in the GLOBAL corpus root — the served
/data tree — under their blog-section category, with provenance
(source_url + chunk ref) in frontmatter.
"""

from __future__ import annotations

from collections.abc import Callable

from app.corpus.writer import (
    ArtifactInput,
    artifact_path,
    check_rule_sections,
    reindex_artifact,
    render_markdown,
    validate_artifact,
    write_artifact,
)
from app.deps import Deps
from app.ingest.chunk import Chunk, chunk_sections
from app.ingest.distill import distill_chunk
from app.ingest.extract import extract_sections
from app.ingest.fetch import fetch_html
from app.openrouter import make_chat_client

Distiller = Callable[[Chunk], list[ArtifactInput]]


async def run_ingest(
    url: str,
    deps: Deps,
    *,
    fetch: Callable[[str], str] = fetch_html,
    distill: Distiller | None = None,
) -> dict:
    """Ingest one post; returns {url, written, skipped_chunks, ids}."""
    distill = distill or _default_distiller(deps)
    sections = extract_sections(fetch(url))
    chunks = chunk_sections(url, sections)
    written_ids: list[str] = []
    skipped_chunks = 0
    for chunk in chunks:
        specs = distill(chunk)
        if not specs:
            skipped_chunks += 1
            continue
        for spec in specs:
            await _write_and_index(deps, spec)
            written_ids.append(spec.id)
    summary = {
        "url": url,
        "written": len(written_ids),
        "skipped_chunks": skipped_chunks,
        "ids": written_ids,
    }
    deps.audit.record("ingest", summary)
    return summary


def _default_distiller(deps: Deps) -> Distiller:
    client = deps.chat.get()
    return lambda chunk: distill_chunk(chunk, deps.settings, client)


async def _write_and_index(deps: Deps, spec: ArtifactInput) -> None:
    check_rule_sections(spec)
    path = artifact_path(deps.corpus.global_root, spec)
    rendered = render_markdown(spec)
    artifact = validate_artifact(spec, "global", path, rendered)
    write_artifact(path, rendered)
    await reindex_artifact(deps, artifact, path)
