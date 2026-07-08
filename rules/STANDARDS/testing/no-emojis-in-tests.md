---
id: no-emojis-in-tests
title: No emojis in test files or test output
category: STANDARDS
domain: testing
severity: low
created: 2026-07-06
applies_when:
  paths: ["**/*.test.*", "tests/**"]
  intents:
    - write test
    - add test
    - fixture
    - test output
check:
  kind: regex
  pattern: '(?:[\u2600-\u27BF\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF])'
related:
  - tests-by-feature-then-type
---

## What this rule says

Test files, test names, assertion messages, fixture data, and test log output
contain no emoji or pictographic characters. Status is communicated with
words ("PASS", "FAIL", "SKIP") and exit codes, not pictographs. The `check`
regex above matches the common emoji blocks (Miscellaneous Symbols, Dingbats,
the variation selector, and the supplementary pictographic planes via
surrogate pairs) and is enforced by `betterai check`.

## Why it matters

Emojis in tests are noise with real costs: they break in CI logs and
terminals with limited font coverage, rendering as tofu boxes exactly where
you are trying to read a failure; they defeat grep-ability (nobody greps for
a party popper); they creep from decoration into semantics ("green check
means passed") which silently inverts when a font or terminal drops the
glyph; and they churn diffs when contributors' editors normalize them
differently. Test output is an operational surface read at 2am over ssh - it
gets the plainest possible encoding.

## When this applies

- Any file under `tests/` or matching `*.test.*`.
- Test names, docstrings, `assert` messages, print/log statements in tests.
- Fixture content, EXCEPT when the emoji is itself the system under test
  (e.g. a unicode-handling test asserting emoji round-trip through a parser) -
  in that case use escape sequences (`"\U0001F389"`) rather than literal
  glyphs, which also keeps this rule's regex check quiet.

## What good looks like

Plain-word status in test output and names:

```python
def test_indexer_skips_unchanged_artifacts_by_content_hash():
    # arrange
    artifact = make_artifact(body="unchanged")
    # act
    report = indexer.index([artifact, artifact])
    # assert
    assert report == {"indexed": 1, "skipped": 1}, "expected hash short-circuit"
```

## Anti-patterns

Wrong - decorative pictographs in names and messages (shown as escapes here
because this corpus is itself emoji-free):

```python
def test_indexer_works():  # name followed by "\U0001F680"
    print("\u2705 all good!")  # check-mark glyph as the pass signal
    assert result, "\U0001F4A5 boom"
```

Fixed: descriptive test name, plain-word assertion message, no print-based
status at all - the runner already reports pass/fail.

## Examples

Testing unicode handling without tripping the rule - the emoji under test is
expressed as an escape sequence, so the source file stays pictograph-free:

```python
def test_frontmatter_parser_preserves_emoji_in_titles():
    # arrange
    title = "release \U0001F389 notes"
    # act
    parsed = parse_frontmatter(f"---\ntitle: {title}\n---\n")
    # assert
    assert parsed.title == title
```
