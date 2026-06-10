# Debugging BetterAI

When an agent's output doesn't reflect a rule you expected, or when the container won't come up, or when an MCP call returns 401 you didn't expect — this is the doc.

The three primary CLI verbs are diagnostic: `status`, `why`, `replay`. Use them in that order.

---

## `betterai status`

```
$ betterai status

CONTAINER  betterai (image @sha256:1234...) up 2h, healthy
ENDPOINT   http://127.0.0.1:7777/mcp (bearer OK)

GLOBAL     ~/.betterai/                       13 rules / 5 skills / 5 memories
REPO       /Users/nicov/work/myapp/.betterai/  3 rules / 0 skills / 1 memory

LAST RETRIEVE (3m ago):
  scopes_queried: [global, repo]
  rules_returned: 7
  overridden_global_ids: [use-snake-case]
  latency_ms: 31
```

What each field means:

- **CONTAINER** — the docker container's name, the pinned image SHA, uptime, health-check state. If this line says `down`, the container isn't running; `docker compose -f ~/.betterai/docker-compose.yml up -d`.
- **ENDPOINT** — the MCP URL and whether the local CLI's bearer token can authenticate. If this says `bearer FAIL`, regenerate via `betterai token rotate`.
- **GLOBAL / REPO** — corpus counts. If REPO is missing, you're not inside a git repo with a `.betterai/` directory; `betterai new rule --scope repo` will scaffold one.
- **LAST RETRIEVE** — the most recent audit event. Mirrors the audit JSONL row. `overridden_global_ids` shows which global rules were dropped because the repo declared the same id.

`betterai status --offline` skips the container check entirely and reads the corpus + audit log directly from disk. Useful when the container is down and you just want to know what's authored.

---

## `betterai why <task> --context <file>`

```
$ betterai why "refactor webhook handler" --context src/webhooks/stripe.ts

Routing decision:
  router_id_matched: by-path-glob
  router_rule_index: 0
  domains_queried: [idempotency, security, observability]

Rules that would fire (top 5 of 7):
  [REPO; overrides global] use-snake-case         severity=high  score=0.91
  [GLOBAL]                  no-broad-catch         severity=high  score=0.88
  [GLOBAL]                  webhook-idempotency   severity=high  score=0.86
  [REPO]                    project-uses-redis     severity=med   score=0.79
  [GLOBAL]                  log-with-context       severity=med   score=0.71

Skills that would fire:
  [GLOBAL]                  write-vitest-fixture

Memories that would fire:
  [GLOBAL]                  webhook-replay-uses-redis-not-postgres (decision, long)
```

Reading the output:

- **`[GLOBAL]` / `[REPO]`** — which corpus supplied each artifact. `[REPO; overrides global]` means the same id existed in both, and the repo version replaced the global.
- **`score`** — the retrieval score (severity × match-strength × recency). Higher is more relevant.
- **`Routing decision`** — which `_meta/domain-router.yaml` entry matched. Useful when you expected a different domain and want to know why the router landed where it did.

`betterai why ... --offline` runs the in-process router + grep with no server call, useful for "what would the server return if it were up." `betterai why ... ` (default) hits the server and reports what the server actually returned, including any cache hit.

---

## `betterai replay --since 7d`

```
$ betterai replay --since 7d

Sessions: 12  (4 main, 6 agent-tool, 2 workflow)
Rules fired: 47 distinct (top 10 by fire_count)
  no-broad-catch                 fired 22x  applied 18x (82%)
  webhook-idempotency            fired 14x  applied 13x (93%)
  ...

Missed retrievals: 3
  parent_session=xyz, subagent_class=workflow, no retrieve_context call
  ...

Overrides observed: 4
  use-snake-case  (global → repo:my-react-app)  observed in 8 sessions
  ...
```

Reading the digest:

- **Sessions** — counts by `subagent_class`. If `agent-tool` and `workflow` counts are zero on a week where you ran subagent flows, the auto-retrieval levers aren't propagating. Check `~/.claude/CLAUDE.md` for the preamble line.
- **Rules fired / applied** — `fire_count` from the audit log + the v2 self-learning `downstream_apply_event_id` join (null in v1; populated by the Phase 4 analyzer once it ships).
- **Missed retrievals** — sessions where a code-writing tool was called without a recent `retrieve_context` for the same `parent_agent_session_id`. The "lever (b)" signal from the multi-agent eng review.
- **Overrides observed** — which repo-scoped rules replaced their global counterparts and how often.

`betterai replay --since 7d --json` dumps the same data as JSON for piping into a digest script.

---

## Error code table (placeholder for DX-FIX-9 `[BAI-NNN]` taxonomy)

The full taxonomy is queued under TD-D6 (DX fix); this is the placeholder so the doc layout is in place when the codes land. Until then, errors surface with their internal code (e.g. `AUDIT_MISSING_PARENT`) — same string, no `[BAI-NNN]` prefix yet.

| Code | Meaning | Most common cause |
|---|---|---|
| `BAI-001` | Container unreachable | Container not running, or port 7777 collision |
| `BAI-002` | Bearer token mismatch | Token rotated; CLI cached the old one |
| `BAI-003` | Corpus root not mounted | `~/.betterai` doesn't exist; install script not run |
| `BAI-004` | Corpus validation error | A rule/skill/memory file has malformed frontmatter; run `betterai validate` |
| `BAI-005` | Duplicate id within scope | Two files share the same id in the same scope; rename one |
| `BAI-006` | Forbidden check.kind | `check.kind: shell` or `ts-module` in a rule frontmatter; dropped in v1 |
| `BAI-007` | Audit emit refused | Subagent event missing `parent_agent_session_id`; bug in the handler |
| `BAI-008` | Missed retrieval | Code-writing tool fired without a recent `retrieve_context` for this session |
| `BAI-009` | Repo corpus unreachable | A repo's `.betterai/` exists on the host but isn't visible through the projects mount |
| `BAI-010` | Connection limit hit | More than 16 in-flight retrievals; 429 returned, queue overflow |

Full code descriptions, retry semantics, and remediation steps land with TD-D6.

---

## Common gotchas

### Container down

```
betterai why ...
# error: BAI-001: Container unreachable at 127.0.0.1:7777
```

Run `docker compose -f ~/.betterai/docker-compose.yml up -d`, then `betterai status` to confirm. If the container starts and immediately exits, check `docker logs betterai` for a startup error.

The most common startup failures are:
- **Token file missing** — `~/.betterai/token` doesn't exist. The install script writes this on first run; if you deleted it, regenerate with `betterai token rotate` or `head -c 32 /dev/urandom | base64 > ~/.betterai/token && chmod 600 ~/.betterai/token`.
- **Port 7777 in use** — another process bound it. `lsof -iTCP:7777 -sTCP:LISTEN` to find the culprit.
- **UID/GID mismatch** — the compose file was generated for a different host user; `betterai install --refresh-compose` rewrites it.

### Bearer token mismatch

```
betterai status
# ENDPOINT  http://127.0.0.1:7777/mcp (bearer FAIL)
```

The CLI reads the bearer from `~/.betterai/token` and presents it as `Authorization: Bearer <token>`. If the file was rotated but the agent's MCP settings still have the old token, every call returns 401. Fix:

```bash
# 1. Read the current token.
cat ~/.betterai/token

# 2. Update ~/.claude/mcp_settings.json (or your agent's MCP config) with
#    that exact string in the bearer field.
# 3. Restart your agent.
```

### Missed retrieval (subagent never asked)

The Claude Code main agent retrieved fine, but a `Workflow agent()` subagent wrote code without a single `retrieve_context` call. Two checks:

- Open `~/.claude/CLAUDE.md` — does it contain a preamble line directing every agent to call `retrieve_context` first? If not, run `betterai install --enable-auto-retrieve` (lever (a) from the multi-agent eng review).
- Did the orchestrator's prompt to the subagent mention retrieval? Workflow subagent prompts are hand-authored by the orchestrator; that's a prompt-engineering responsibility, not a BetterAI bug. Lever (b) — the server's `missed_retrieval` audit event — surfaces this in `betterai replay`.

### Rule didn't fire when you expected it to

Debug ladder, in order:

1. `betterai validate` — did the frontmatter break? A missing required field silently drops the rule from the corpus.
2. `betterai why <task> --context <file>` — does the router actually route to the domain the rule is in? If not, edit `rules/_meta/domain-router.yaml` to add the path or intent.
3. Read the rule's `applies_when.paths` glob. Does the file path (after host→container translation) actually match?
4. Check `betterai replay` for a recent `retrieve_context` event with the file in question; the audit log shows which rules were returned and their scores. If the rule was returned but ranked too low, raise its severity or sharpen its `applies_when`.

### Repo `.betterai/` not detected

The repo-root detection walks up to the nearest `.git/`. If your project doesn't have one (e.g. it's a subdir of a larger repo), the detector falls back to global-only and the repo corpus is invisible. Either:

- Initialize the project as its own git repo (`git init` in the project root), OR
- Move the `.betterai/` directory up to wherever the existing `.git/` is.

If the repo IS a git repo but the projects mount doesn't include it (the container can only see what's mounted), `betterai status` will warn: `repo detected at <path> but not reachable in container; corpus skipped`. Either move the repo under `~/projects/` or add another bind mount to `docker-compose.yml`.

### Repo override surprised you

A repo declared `use-snake-case` with the same id as the global rule, and you expected both versions to surface. By design, only the repo version is returned; the global is dropped. `betterai status` shows the override in the LAST RETRIEVE block (`overridden_global_ids: [use-snake-case]`). If you want the global to win, rename the repo file's id to something distinct.

---

## When to file a bug vs fix the corpus

- **Fix the corpus** when: the rule didn't fire because the frontmatter is wrong, the domain-router doesn't route to it, the body H2 sections are missing, or the file is in the wrong shard.
- **File a bug** when: the rule's frontmatter and body are valid per `rules/_meta/schema.md`, `betterai why` shows it should fire, but `betterai replay` shows the server didn't return it. That's a retrieval bug.

---

## Typed error codes (BAI-*)

Every typed error in BetterAI extends `BetterAIError` (`src/errors/base.ts`) and
carries a stable `code` plus an optional `httpStatus`. The classes + factories
live in `src/errors/index.ts`; domain modules re-export them so existing import
paths still work. Match on the **code**, not the human message — the message can
drift, the code will not.

Code-block allocation:

| Block     | Domain                | Codes in use |
|-----------|-----------------------|--------------|
| `BAI-1xx` | config / bootstrap    | `BAI-101` bearer token missing · `BAI-102` bearer token empty/whitespace · `BAI-110` gate already in progress · `BAI-111` no gate in progress |
| `BAI-2xx` | auth / authz          | (reserved — bearer 401 host/unauthorized envelopes not yet migrated to typed errors) |
| `BAI-3xx` | contract / validation | `BAI-301` `ValidationError` (MCP tool input validation) |
| `BAI-4xx` | retrieval / corpus    | `BAI-401` `RuleNotFoundError` (explain_rule miss) |
| `BAI-5xx` | audit / io / resource | `BAI-501` `AuditIoError` · `BAI-502` `AuditValidationError` · `BAI-510` `TooManyInFlightError` (limiter overflow, HTTP 429) |

### Legacy observable shapes (intentional)

Two retrofitted errors keep a non-BAI `code` for backward compatibility and
stash the BAI identifier on `baiCode`:

- **`AuditIoError`** — `.code` is the underlying **errno** string (`"EACCES"`,
  `"EISDIR"`, …) or `null`; `.baiCode === "BAI-501"`; `.path` is the audit path;
  `.cause` is the original errno error.
- **`TooManyInFlightError`** — `.code === "too_many_in_flight"`, `.status === 429`,
  `.baiCode === "BAI-510"`.

Everywhere else, `.code` is the BAI identifier directly.

The corpus is the moat, not the plumbing. Spending an extra five minutes per rule on the frontmatter saves hours of debugging later.
