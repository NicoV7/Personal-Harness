"""Chunking: one chunk per paragraph, short paragraphs merged forward.

Chunk ids are deterministic (`<url-slug>#<index>`) so re-ingesting the
same post yields the same source_refs and the content-hash short-circuit
in retrieval ingest keeps re-runs cheap. The source posts pack several
tips into one long paragraph, so a chunk is a *distillation unit*, not a
one-artifact unit — the distiller may emit multiple artifacts per chunk.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.ingest.extract import Section

MERGE_BELOW_CHARS = 240
_SLUG_STRIP = re.compile(r"[^a-z0-9-]+")


@dataclass(frozen=True)
class Chunk:
    id: str
    source_url: str
    section: str | None
    text: str


def chunk_sections(url: str, sections: list[Section]) -> list[Chunk]:
    slug = url_slug(url)
    chunks: list[Chunk] = []
    for section in sections:
        for text in _merged_paragraphs(section.paragraphs):
            chunks.append(
                Chunk(
                    id=f"{slug}#{len(chunks)}",
                    source_url=url,
                    section=section.heading,
                    text=text,
                )
            )
    return chunks


def url_slug(url: str) -> str:
    tail = [part for part in url.split("/") if part][-1].lower()
    return _SLUG_STRIP.sub("-", tail).strip("-") or "source"


def _merged_paragraphs(paragraphs: list[str]) -> list[str]:
    """Merge sub-threshold paragraphs into the following one; a trailing
    short paragraph still becomes its own chunk rather than being lost."""
    merged: list[str] = []
    pending = ""
    for paragraph in paragraphs:
        pending = f"{pending}\n\n{paragraph}".strip()
        if len(pending) >= MERGE_BELOW_CHARS:
            merged.append(pending)
            pending = ""
    if pending:
        merged.append(pending)
    return merged
