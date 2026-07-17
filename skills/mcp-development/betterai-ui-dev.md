---
id: betterai-ui-dev
title: Extend the BetterAI local dashboard (betterai ui)
category: mcp-development
when_to_use: When changing app/ui/**, app/api/routes.py, or anything the dashboard serves or consumes
applies_when:
  paths:
    - app/ui/**
    - app/api/**
  intents:
    - dashboard
    - web ui
    - local ui
    - observability page
---

## Steps

1. Keep the two-process split intact: the container serves skill CRUD at
   `/api/*` (thin wrappers over MCP handlers in `app/api/routes.py`,
   registered BEFORE the FastMCP mount); the host `betterai ui` process
   (`app/ui/server.py`) serves static files, `/api/local/*` host data
   (audit tail, stats, hook errors, doctor), and proxies everything else
   with the bearer token injected server-side. The token must never
   reach browser JS, the URL bar, or a log line.
2. Container API handlers call MCP handlers with
   `CallMeta(agent_session_id=None, subagent_class="ui")` — the None
   session id keeps read-receipt/gate state untouched; the "ui" class
   keeps audit events attributable and excluded from usage stats
   (`compute_stats` filters them).
3. Host data reads are byte-capped tails (`MAX_TAIL_BYTES`) over
   `~/.betterai/audit/audit.jsonl` and `hook-errors.log`; skip
   unparseable lines, never buffer the whole file. Doctor data comes
   from `app/doctor.py` `run_doctor` — host-side only, because docker
   binaries, file modes, and client configs are invisible in-container.
4. Frontend is no-build by design: vendored, pinned Preact + htm +
   marked ESM under `app/ui/static/vendor/` resolved via the import map
   in `index.html`. No CDN at runtime, no npm, no bundler. Global state
   + full re-render (`update()` in `app.js`); YAML never touches the
   browser — edit forms submit the `ArtifactInput` JSON shape and the
   server renders frontmatter.
5. Errors surface as the server's typed envelopes
   (`{"error": "BAI-xxx", "message": ...}`): the proxy maps transport
   failure to BAI-601 (with the `betterai start` recovery) and a missing
   token to BAI-210; the frontend shows envelopes verbatim in the
   banner. Never swallow one into a blank state.
6. Port selection is bind-once: `bind_ui_socket` binds 7788 or an
   OS-assigned port and hands the socket to uvicorn (no TOCTOU rebind);
   an explicit `--port` conflict fails loud with BAI-121.
7. Test at the seams like `tests/ui/`: local API against synthetic
   `~/.betterai` trees under tmp_path, the proxy through
   `httpx.ASGITransport` against a fake upstream asserting the
   Authorization header, and port picking with real loopback sockets.

## What good looks like

A new dashboard capability lands as: container route (if it mutates the
corpus) + `/api/local/*` route (if it reads host files) + a page module
under `app/ui/static/pages/`, with tests at each seam and no new
runtime dependencies.
