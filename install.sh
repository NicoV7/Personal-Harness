#!/usr/bin/env bash
# BetterAI one-command install (DX-FIX-2).
#
# Idempotent: re-running this script does not clobber existing state.
# Each step short-circuits if it's already done.
#
# Steps:
#   1. Pre-flight: check docker is installed.
#   2. Scaffold ~/.betterai/{rules,skills,memories,audit,embeddings,welcome-task,token}.
#   3. Download docker-compose.yml from the pinned release URL.
#   4. Substitute $UID/$GID into the compose file.
#   5. Generate a 32-byte bearer token (mode 0600).
#   6. docker compose up -d.
#   7. Wait for /health to return 200.
#   8. docker exec betterai betterai init --seed (seeds corpus + welcome task).
#   9. PROMPT (default Y) to install CLAUDE.md preamble (auto-retrieve lever a).
#  10. PROMPT (default n) to install the auto-retrieve skill (lever c).
#  11. Print success message with the MCP endpoint snippet and next steps.

set -eu

# ─── Configuration ────────────────────────────────────────────────────────────

# Pinned by SHA, NOT :latest, per the install-script acceptance criterion.
BETTERAI_IMAGE="ghcr.io/betterai/betterai-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
COMPOSE_URL="https://github.com/betterai/betterai/releases/download/v1.0.0/docker-compose.yml"
BETTERAI_HOME="${BETTERAI_HOME:-$HOME/.betterai}"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PORT="${BETTERAI_MCP_PORT:-7777}"

# ─── Tiny helpers ─────────────────────────────────────────────────────────────

log()  { printf "[install] %s\n" "$*"; }
warn() { printf "[install] WARN: %s\n" "$*" >&2; }
die()  { printf "[install] ERROR: %s\n" "$*" >&2; exit 1; }

prompt_default_yes() {
  # $1: prompt text
  if [ ! -t 0 ]; then return 0; fi  # non-interactive: accept the default
  printf "%s [Y/n] " "$1"
  read -r answer
  case "$answer" in
    n|N|no|NO|No) return 1 ;;
    *) return 0 ;;
  esac
}

prompt_default_no() {
  if [ ! -t 0 ]; then return 1; fi  # non-interactive: accept the default
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ─── Step 1: pre-flight ───────────────────────────────────────────────────────

log "Step 1/11: pre-flight check"
command -v docker >/dev/null 2>&1 || die "docker is not installed. Install Docker Desktop and re-run."
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing. Install Docker Desktop (Compose v2) and re-run."

# ─── Step 2: scaffold ~/.betterai/ ───────────────────────────────────────────

log "Step 2/11: scaffold $BETTERAI_HOME"
mkdir -p \
  "$BETTERAI_HOME/rules" \
  "$BETTERAI_HOME/skills" \
  "$BETTERAI_HOME/memories" \
  "$BETTERAI_HOME/audit" \
  "$BETTERAI_HOME/embeddings" \
  "$BETTERAI_HOME/welcome-task"

# ─── Step 3: download compose ────────────────────────────────────────────────

COMPOSE_PATH="$BETTERAI_HOME/docker-compose.yml"
if [ -f "$COMPOSE_PATH" ]; then
  log "Step 3/11: docker-compose.yml already at $COMPOSE_PATH (skipping download)"
else
  log "Step 3/11: downloading docker-compose.yml from $COMPOSE_URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$COMPOSE_URL" -o "$COMPOSE_PATH" || warn "download failed; writing fallback compose"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$COMPOSE_URL" -O "$COMPOSE_PATH" || warn "download failed; writing fallback compose"
  fi
  if [ ! -s "$COMPOSE_PATH" ]; then
    # Fallback: emit a minimal compose locally so install still works without
    # network access to the release artifact. The pinned SHA image is the only
    # contract that matters.
    cat > "$COMPOSE_PATH" <<COMPOSE
services:
  betterai:
    image: $BETTERAI_IMAGE
    container_name: betterai
    user: "\${UID_GID}"
    ports:
      - "127.0.0.1:$PORT:7777"
    volumes:
      - $BETTERAI_HOME:/data
      - $HOME/projects:/projects:ro
    environment:
      BETTERAI_CORPUS_ROOT: /data
      BETTERAI_AUDIT_PATH: /data/audit/audit.jsonl
      BETTERAI_PROJECTS_ROOT: /projects
      BETTERAI_MCP_PORT: 7777
      BETTERAI_TOKEN_PATH: /data/token
      BETTERAI_LOG_LEVEL: info
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1:7777/health"]
      interval: 10s
      timeout: 3s
      retries: 5
COMPOSE
  fi
fi

# ─── Step 4: substitute UID/GID ──────────────────────────────────────────────

log "Step 4/11: substituting UID:GID"
UID_VAL="$(id -u)"
GID_VAL="$(id -g)"
export UID_GID="${UID_VAL}:${GID_VAL}"
# Replace any literal ${UID}:${GID} marker in the compose file. Compose v2
# also expands $UID_GID at runtime from our exported env above; this sed
# substitution covers the case where the compose was written with the literal.
if grep -q '\${UID}:\${GID}' "$COMPOSE_PATH"; then
  sed -i.bak "s|\${UID}:\${GID}|${UID_GID}|g" "$COMPOSE_PATH" && rm -f "$COMPOSE_PATH.bak"
fi

# ─── Step 5: bearer token ────────────────────────────────────────────────────

TOKEN_PATH="$BETTERAI_HOME/token"
if [ -s "$TOKEN_PATH" ]; then
  log "Step 5/11: bearer token already present at $TOKEN_PATH (preserving)"
else
  log "Step 5/11: generating 32-byte bearer token"
  # Two fallbacks so install works on barebones systems.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$TOKEN_PATH"
  else
    head -c 32 /dev/urandom | xxd -p -c 64 > "$TOKEN_PATH"
  fi
  chmod 0600 "$TOKEN_PATH"
fi
TOKEN_VAL="$(cat "$TOKEN_PATH")"

# ─── Step 6: docker compose up ───────────────────────────────────────────────

log "Step 6/11: starting container"
docker compose -f "$COMPOSE_PATH" up -d

# ─── Step 7: wait for /health ────────────────────────────────────────────────

log "Step 7/11: waiting for healthcheck (up to 30s)"
ok=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -fsS -H "Authorization: Bearer $TOKEN_VAL" "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    ok="yes"; break
  fi
  sleep 2
done
if [ -z "$ok" ]; then
  warn "container did not report healthy in 30s — continuing, but check 'docker logs betterai'"
fi

# ─── Step 8: seed corpus + welcome task ──────────────────────────────────────

if [ -f "$BETTERAI_HOME/welcome-task/README.md" ] && [ -d "$BETTERAI_HOME/rules/STANDARDS" ]; then
  log "Step 8/11: corpus + welcome task already seeded (skipping)"
else
  log "Step 8/11: seeding corpus + welcome task via container"
  docker exec betterai betterai init --seed || warn "seed exec failed; you can run 'betterai init --seed' manually later"
fi

# ─── Step 9: PROMPT — CLAUDE.md preamble (lever a) ───────────────────────────

CLAUDE_MD="$CLAUDE_HOME/CLAUDE.md"
PREAMBLE_LINE="<!-- betterai-auto-retrieve: when starting a non-trivial task, call retrieve_context first -->"
if grep -Fq "$PREAMBLE_LINE" "$CLAUDE_MD" 2>/dev/null; then
  log "Step 9/11: CLAUDE.md preamble already present (skipping)"
elif prompt_default_yes "Step 9/11: append BetterAI auto-retrieve preamble to $CLAUDE_MD?"; then
  mkdir -p "$CLAUDE_HOME"
  touch "$CLAUDE_MD"
  printf "\n%s\n" "$PREAMBLE_LINE" >> "$CLAUDE_MD"
  log "  appended preamble to $CLAUDE_MD"
else
  log "  skipped CLAUDE.md preamble (you can add it later)"
fi

# ─── Step 10: PROMPT — auto-retrieve skill (lever c) ─────────────────────────

SKILL_DIR="$CLAUDE_HOME/skills/betterai-auto-retrieve"
SKILL_FILE="$SKILL_DIR/SKILL.md"
if [ -f "$SKILL_FILE" ]; then
  log "Step 10/11: auto-retrieve skill already installed (skipping)"
elif prompt_default_no "Step 10/11: install the betterai-auto-retrieve skill into Claude Code?"; then
  mkdir -p "$SKILL_DIR"
  cat > "$SKILL_FILE" <<SKILL
---
name: betterai-auto-retrieve
description: Before writing code, call retrieve_context with the file paths and intent. The result lists the rules, skills, and memories the BetterAI moat thinks apply here.
---

When you are about to write or edit code, call \`mcp__betterai__retrieve_context\`
with the candidate file paths. Surface the returned rules, skills, and memories
in your plan. If a rule conflicts with a long-durability decision-memory, follow
the memory and flag the conflict.
SKILL
  log "  installed $SKILL_FILE"
else
  log "  skipped auto-retrieve skill"
fi

# ─── Step 11: success message ────────────────────────────────────────────────

cat <<DONE

[install] Step 11/11: done.

MCP endpoint:  http://127.0.0.1:$PORT/mcp
Bearer token:  $TOKEN_VAL
                (also at $TOKEN_PATH, mode 0600)

Paste this snippet into your Claude Code MCP config:

  "betterai": {
    "transport": "http",
    "url": "http://127.0.0.1:$PORT/mcp",
    "headers": { "Authorization": "Bearer $TOKEN_VAL" }
  }

Try the welcome task:
  cat $BETTERAI_HOME/welcome-task/README.md

Verify installation:
  betterai status

DONE
