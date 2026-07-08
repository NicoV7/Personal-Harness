---
id: implement-installable-harness-package
title: Implement the no-npx BetterAI harness installer and client adapters
category: release
when_to_use: |
  When changing the BetterAI one-command install path, Docker/Supergateway
  bridge, Claude/Codex client adapters, provider config, hook toggles, or
  secret-handling behavior.
steps_count: 8
estimated_minutes: 45
applies_when:
  paths:
    - install.sh
    - docker-compose.yml
    - Dockerfile
    - src/cli/**
    - src/hooks/**
  intents:
    - install harness
    - no npx
    - configure codex
    - configure claude
    - provider config
related_rules:
  - no-catch-all-exception-masking
  - surgical-changes
  - fail-loud-no-retries
related_skills:
  - write-vitest-fixture
  - run-betterai-eval
  - run-harness-evals
  - verify-always-consult-skills
created: 2026-06-17
---

## When to use this skill

Use this whenever the install path or client integration layer changes. The
installer is a trust boundary: it writes config under a user's home directory,
starts Docker, and handles bearer/provider secrets.

## Steps

1. Keep the public install path free of `npx`; use `curl | bash`, Docker
   Compose, and generated local shell shims. For the Python backend
   (`BetterAI-Python/backend/`), the CLI distributes via `uv tool install`
   (cross-OS, no Node toolchain); the compose stack stays the reproducible
   runtime environment.
2. Never print bearer tokens or provider keys. Client configs point at
   `~/.betterai/bin/betterai-mcp-stdio`, which reads the token at runtime.
3. Treat Supergateway as an installed Docker dependency for stdio clients, not
   as a Node runtime dependency.
4. Prefer first-class adapters for Claude Code and Codex. Put all edits behind
   sentinel blocks or exact hook entries so `harness off` can remove them.
5. Fail hard on provider outages - there is no fallback retrieval mode.
   A hosted embedding failure at install or runtime raises a typed error
   (BAI-604 family) whose message points at the recovery path: run
   `betterai doctor` to diagnose, or `betterai harness off` to disable the
   harness deliberately. Never silently degrade to a local/offline index;
   see the `fail-loud-no-retries` rule.
6. Preserve the agent instruction contract: retrieve context, read matched
   skills, then run the clean-code pass when editing code.
7. Test with temporary `HOME` directories, checking file modes and that no
   secret values appear in generated config files.
8. Run `npm run typecheck`, focused Vitest suites, and the relevant
   `run-harness-evals` smoke path before releasing.

## What good looks like

A fresh user can run the public curl command, get a running `betterai`
container, have Claude/Codex point at the MCP server through a bridge command,
and verify the install with `betterai doctor` without copying a token into any
agent config.
