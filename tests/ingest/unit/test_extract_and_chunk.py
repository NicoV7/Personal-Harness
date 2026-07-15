"""Extraction + chunking against the checked-in blog HTML fixtures.

The fixtures are byte-for-byte snapshots of the two source posts, so
these tests pin the real page shapes: the tips post uses <hr>-separated
sections titled by short bare paragraphs; the backend post is one
heading-less stream of prose paragraphs.
"""

from __future__ import annotations

from pathlib import Path

from app.ingest.chunk import MERGE_BELOW_CHARS, chunk_sections, url_slug
from app.ingest.extract import extract_sections

FIXTURES = Path(__file__).parent.parent / "fixtures"
TIPS_URL = "https://august.mataroa.blog/blog/tips-for-full-stack-engineering/"
BACKEND_URL = "https://august.mataroa.blog/blog/writing-acceptable-backend-code/"


def _sections(name: str):
    return extract_sections((FIXTURES / f"{name}.html").read_text())


class TestExtract:
    def test_tips_post_yields_three_named_sections(self):
        # act
        sections = _sections("tips-for-full-stack-engineering")

        # assert
        headings = [section.heading for section in sections]
        assert headings == [
            "Stacks, languages, databases",
            "Networks and CyberSecurity",
            "Testing",
        ]
        assert len(sections[0].paragraphs) == 2
        assert len(sections[1].paragraphs) == 11
        assert sections[2].paragraphs == []  # the post ends at the Testing stub

    def test_backend_post_yields_one_unnamed_section(self):
        # act
        sections = _sections("writing-acceptable-backend-code")

        # assert
        assert len(sections) == 1
        assert sections[0].heading is None
        assert len(sections[0].paragraphs) == 15

    def test_footer_chrome_is_excluded(self):
        # act
        sections = _sections("tips-for-full-stack-engineering")

        # assert
        text = " ".join(p for section in sections for p in section.paragraphs)
        assert "Subscribe via" not in text
        assert "Powered by" not in text


class TestChunk:
    def test_chunk_ids_are_deterministic_slug_index_pairs(self):
        # arrange
        sections = _sections("writing-acceptable-backend-code")

        # act
        first = chunk_sections(BACKEND_URL, sections)
        second = chunk_sections(BACKEND_URL, sections)

        # assert
        assert [c.id for c in first] == [c.id for c in second]
        assert first[0].id == "writing-acceptable-backend-code#0"

    def test_short_paragraphs_merge_forward(self):
        # arrange
        sections = _sections("writing-acceptable-backend-code")

        # act
        chunks = chunk_sections(BACKEND_URL, sections)

        # assert: 15 paragraphs collapse into fewer, denser chunks
        assert 5 <= len(chunks) < 15
        assert all(
            len(c.text) >= MERGE_BELOW_CHARS for c in chunks[:-1]
        )  # only the trailing chunk may stay short
        joined = " ".join(c.text for c in chunks)
        assert "Do not do retries" in joined
        assert "vacuum" in joined

    def test_chunks_carry_their_section_heading(self):
        # arrange
        sections = _sections("tips-for-full-stack-engineering")

        # act
        chunks = chunk_sections(TIPS_URL, sections)

        # assert
        assert {c.section for c in chunks} == {
            "Stacks, languages, databases",
            "Networks and CyberSecurity",
        }

    def test_url_slug_strips_scheme_and_trailing_slash(self):
        assert url_slug(TIPS_URL) == "tips-for-full-stack-engineering"
