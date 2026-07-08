#!/usr/bin/env bash
# BetterAI bootstrap: install the Python CLI with uv, then let
# `betterai install` do the real work (dirs, token, .env, compose,
# adapters, hook scripts). No npx anywhere. Fail loud on anything
# missing - no silent fallbacks (fail-loud-no-retries).
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required. Install it and re-run." >&2
    exit 1
  }
}

need docker
docker compose version >/dev/null 2>&1 || {
  echo "error: docker compose v2 is required." >&2
  exit 1
}

if ! command -v uv >/dev/null 2>&1; then
  echo "error: 'uv' is required (https://docs.astral.sh/uv/): " >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Installing the betterai CLI from ${REPO_DIR} ..."
uv tool install --force --from "${REPO_DIR}" betterai

echo "Running betterai install (writes ~/.betterai: token, .env, compose, hooks, adapters) ..."
betterai install "$@"

echo "Done. Next: 'betterai start' to bring up the stack, then 'betterai doctor'."
