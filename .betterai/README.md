# BetterAI repo corpus

This directory is the **repo-scoped** half of the BetterAI corpus. It ships with the BetterAI source tree itself — the rules, skills, and memories that fire when a developer (you, future-Nico) is editing the BetterAI server, CLI, or VSCode extension code.

The global half lives at `~/.betterai/` and applies everywhere. This half applies **only** inside this repository, and overrides the global on id-collision (see `_meta/conflict-resolution.md` for the rule).

## Layout

```
.betterai/
  rules/<CATEGORY>/<domain>/<id>.md
  skills/<category>/<id>.md
  memories/<yyyy-mm>/<id>.md
```

Same schema as the global corpus. The schema is the source of truth at `rules/_meta/schema.md` (top level of this repo, not under `.betterai/`).

## How items are picked up

The MCP server walks up from `context.file_paths[0]` to the nearest `.git/` directory, then checks for a sibling `.betterai/`. If found, both corpora are queried; repo wins on id-collision. No frontmatter `scope` field — scope is implicit from which root the file lives in.

## Authoring

- `betterai new rule` (default: repo, when CWD is inside this tree)
- `betterai new rule --scope global` (force global)
- Hand-edit and PR like any other code change.
