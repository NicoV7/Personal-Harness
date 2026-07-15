"""Article extraction: HTML -> ordered sections of prose paragraphs.

Scope is the <article> element (falls back to <main>, then <body>), which
already excludes nav/footer chrome on mataroa-style blogs. Sections split
on <hr> and on h2/h3 headings; a short, punctuation-free paragraph at a
section start is treated as that section's title (the source posts write
"Networks and CyberSecurity" as a bare paragraph between <hr>s, not a
heading tag).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup

SECTION_TITLE_MAX_CHARS = 60
_CONTENT_TAGS = ("h1", "h2", "h3", "p", "hr", "li")
_WHITESPACE = re.compile(r"\s+")


@dataclass
class Section:
    heading: str | None = None
    paragraphs: list[str] = field(default_factory=list)


def extract_sections(html: str) -> list[Section]:
    soup = BeautifulSoup(html, "html.parser")
    container = soup.find("article") or soup.find("main") or soup.body or soup
    sections: list[Section] = []
    current = Section()
    for element in container.find_all(_CONTENT_TAGS):
        text = _WHITESPACE.sub(" ", element.get_text(" ", strip=True)).strip()
        if element.name == "h1":
            continue  # the post title, not a section
        if element.name == "hr":
            current = _flush(sections, current, heading=None)
        elif element.name in ("h2", "h3"):
            current = _flush(sections, current, heading=text or None)
        elif text:
            if current.heading is None and not current.paragraphs and _is_title(text):
                current.heading = text
            else:
                current.paragraphs.append(text)
    _flush(sections, current, heading=None)
    return sections


def _flush(sections: list[Section], current: Section, *, heading: str | None) -> Section:
    if current.heading is not None or current.paragraphs:
        sections.append(current)
    return Section(heading=heading)


def _is_title(text: str) -> bool:
    return len(text) <= SECTION_TITLE_MAX_CHARS and not text.rstrip().endswith(
        (".", "!", "?", ":", ";")
    )
