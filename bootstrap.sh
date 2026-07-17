#!/bin/sh
# BetterAI one-command bootstrap:
#   curl -fsSL https://raw.githubusercontent.com/NicoV7/Personal-Harness/main/bootstrap.sh | sh
#
# POSIX sh on purpose (piped sh has no BASH_SOURCE). Auto-installs uv,
# checks Docker (starting Docker Desktop on macOS if the daemon is
# down), installs the betterai CLI, then chains
# install -> start -> index -> doctor. Re-runs are safe: an existing
# ~/.betterai/.env skips `betterai install` entirely (re-wire clients
# with `betterai harness on`, never by re-installing).
#
# Env overrides:
#   BETTERAI_REPO         git source (default: the public GitHub repo)
#   BETTERAI_REF          git tag/branch to install (default: main)
#   BETTERAI_JUDGE_MODEL  OpenRouter judge model id
#   BETTERAI_OPENROUTER_KEY_FILE  path to a file containing the API key
set -eu

REPO="${BETTERAI_REPO:-https://github.com/NicoV7/Personal-Harness}"
REF="${BETTERAI_REF:-main}"

say()  { printf '\033[1m[betterai]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[betterai]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Docker ---------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin) fail "Docker is required. Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/ then re-run." ;;
    Linux)  fail "Docker is required. Install it: https://docs.docker.com/engine/install/ then re-run." ;;
    *)      fail "Docker is required: https://docs.docker.com/get-docker/" ;;
  esac
fi

if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    say "Docker daemon is down — starting Docker Desktop..."
    open -a Docker
    tries=0
    until docker info >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -gt 30 ] && fail "Docker did not come up after 90s. Start Docker Desktop manually and re-run."
      printf '.'
      sleep 3
    done
    printf '\n'
  else
    fail "Docker daemon is not running. Start it and re-run."
  fi
fi

docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required (ships with Docker Desktop; on Linux install the compose plugin)."

# --- 2. uv -------------------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (https://docs.astral.sh/uv/)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
  export PATH
  command -v uv >/dev/null 2>&1 || fail "uv install finished but 'uv' is not on PATH; open a new shell and re-run."
fi

# --- 3. the betterai CLI ----------------------------------------------
if [ -f "./pyproject.toml" ] && grep -q '^name = "betterai"' ./pyproject.toml 2>/dev/null; then
  say "Installing the betterai CLI from this checkout..."
  uv tool install --force --from "$PWD" betterai
else
  say "Installing the betterai CLI from ${REPO}@${REF}..."
  uv tool install --force --from "git+${REPO}@${REF}" betterai
fi
PATH="$HOME/.local/bin:$PATH"
export PATH

# --- 4. install (skipped when config already exists) -------------------
if [ -f "$HOME/.betterai/.env" ]; then
  say "Existing install detected (~/.betterai/.env) — not rewriting config."
  say "To re-wire clients use: betterai harness on"
  DEGRADED=0
  [ -s "$HOME/.betterai/openrouter-key" ] || DEGRADED=1
else
  set -- install
  [ -n "${BETTERAI_JUDGE_MODEL:-}" ] && set -- "$@" --judge-model "$BETTERAI_JUDGE_MODEL"
  DEGRADED=0
  if [ -n "${BETTERAI_OPENROUTER_KEY_FILE:-}" ]; then
    set -- "$@" --openrouter-key-file "$BETTERAI_OPENROUTER_KEY_FILE"
  elif [ -r /dev/tty ]; then
    # stdin is the curl pipe; the key prompt must read from the terminal.
    say "Running betterai install (key prompt reads from your terminal; empty skips)..."
    betterai "$@" </dev/tty
    [ -s "$HOME/.betterai/openrouter-key" ] || DEGRADED=1
    set --
  else
    say "No terminal available — installing WITHOUT an OpenRouter key (degraded mode)."
    set -- "$@" --no-openrouter-key
    DEGRADED=1
  fi
  if [ "$#" -gt 0 ]; then
    betterai "$@"
    [ "$DEGRADED" -eq 1 ] || { [ -s "$HOME/.betterai/openrouter-key" ] || DEGRADED=1; }
  fi
fi

# --- 5. start -> index -> doctor ---------------------------------------
say "Starting the stack (docker compose up --wait)..."
betterai start

if [ "$DEGRADED" -eq 1 ]; then
  say "SKIPPING index: no OpenRouter key. Write one to ~/.betterai/openrouter-key (chmod 600), then run: betterai index"
else
  say "Indexing the corpus..."
  betterai index
fi

say "Doctor report:"
betterai doctor || true

say "Done. Open the dashboard with: betterai ui"
