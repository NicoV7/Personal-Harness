#!/usr/bin/env bash
# Checkout-mode installer: delegates to bootstrap.sh, which detects the
# checkout (pyproject.toml with name = "betterai") and installs from it.
# The public path is:
#   curl -fsSL https://raw.githubusercontent.com/NicoV7/Personal-Harness/main/bootstrap.sh | sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
exec sh ./bootstrap.sh "$@"
