"""Parser for the plan's "## Files to touch" section.

The grammar is deliberately strict (write-scoped-plan documents it) so a
parse failure is a visible warning + inactive gate rather than a guess
that silently blocks the wrong paths. Entries:

    - path — functions
    - path - functions
    - path
      justify: reason for adding this path after the fact

A `justify:` continuation line marks the preceding entry as a justified
extension (the audited escape hatch for growing the manifest).
"""

from __future__ import annotations

from dataclasses import dataclass

SECTION_HEADING = "## Files to touch"
JUSTIFY_PREFIX = "justify:"
EM_DASH = "—"


@dataclass(frozen=True)
class ManifestEntry:
    path: str
    functions: str
    justified: bool


@dataclass(frozen=True)
class ParsedManifest:
    ok: bool
    entries: tuple[ManifestEntry, ...]
    error: str | None = None


def parse_files_to_touch(markdown: str) -> ParsedManifest:
    """Extract manifest entries; any grammar violation fails the parse."""
    section = _section_lines(markdown)
    if section is None:
        return ParsedManifest(False, (), f"no {SECTION_HEADING!r} section found")
    entries: list[ManifestEntry] = []
    for line in section:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            entry, error = _parse_entry(stripped[2:].strip())
            if error:
                return ParsedManifest(False, (), error)
            entries.append(entry)
            continue
        if stripped.startswith(JUSTIFY_PREFIX):
            if not entries:
                return ParsedManifest(False, (), "justify: line before any entry")
            entries[-1] = ManifestEntry(entries[-1].path, entries[-1].functions, True)
    if not entries:
        return ParsedManifest(False, (), f"{SECTION_HEADING!r} section has no entries")
    return ParsedManifest(True, tuple(entries))


def _section_lines(markdown: str) -> list[str] | None:
    lines = markdown.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.strip() == SECTION_HEADING:
            start = index + 1
            break
    if start is None:
        return None
    body: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        body.append(line)
    return body


def _parse_entry(text: str) -> tuple[ManifestEntry, str | None]:
    path, functions = _split_path_functions(text)
    path = path.strip().strip("`")
    if not path:
        return ManifestEntry("", "", False), f"entry has no path: {text!r}"
    return ManifestEntry(path, functions.strip(), False), None


def _split_path_functions(text: str) -> tuple[str, str]:
    if EM_DASH in text:
        path, functions = text.split(EM_DASH, 1)
        return path, functions
    if " - " in text:
        path, functions = text.split(" - ", 1)
        return path, functions
    return text, ""
