---
id: betterai-v3-theia-rejected
title: v3 Theia desktop frame rejected in favor of VSCode extension + Docker
date: 2026-06-08
project: betterai
kind: decision
context_keywords: [theia, workbench, ide-shell, custom-editor, scope, vscode-extension, docker, surface]
durability: long
auto_captured: false
applies_to_future_intents:
  - "design custom IDE"
  - "build standalone editor app"
  - "Theia-based product"
  - "Electron shell for BetterAI"
related_rules: [simplicity-first]
---

## What happened

The v3 BetterAI design proposed a full Theia AI-based desktop application — a custom IDE shell with its own workbench, file explorer, editor panes, and an integrated agent panel. The intent was to make BetterAI a "destination app" that developers would open instead of VSCode.

During the 2026-06-08 session this was rejected. The replacement shape (now locked as v4) is a VSCode extension as the human-facing surface, backed by a Dockerized MCP retrieval service that any agent (VSCode-extension or otherwise) can call. No custom editor chrome. No Electron. No Theia.

## Why it matters (for future me)

The corpus is the moat. The retrieval quality, the rule schema, the auto-retrieve mechanism — that's what makes BetterAI valuable. None of it requires owning the editor chrome.

Building on Theia means:

- Months of UX work duplicating things VSCode already does well (search, git, debugging, terminal panes).
- Maintaining a fork-shaped relationship with upstream Theia for every release.
- Forcing users to context-switch into a second app instead of meeting them where they already work.
- Zero marginal lift on the actual moat (the corpus).

Meanwhile a VSCode extension ships in days, integrates with the agent the user already has, and lets the Docker service be the source of truth regardless of which front-end calls it.

## Don't relitigate

Do NOT propose Theia, custom Electron shells, or standalone-app frames for BetterAI surfaces. The VSCode extension is the ceiling for human-facing UI. If a future need genuinely cannot be solved inside a VSCode extension (e.g., a multi-pane comparison view that the extension API forbids), the answer is a web dashboard served by the Docker container — not a custom IDE.

The only acceptable reopen condition: VSCode itself deprecates the extension API surface we depend on. Until then, this decision is closed.
