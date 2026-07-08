"""Process entrypoint (`python -m app.main`). Thin on purpose: all wiring
lives in app/server.py so tests and the CLI reuse the same boot path.

Boot failures surface as typed BetterAIError subclasses; this entrypoint
prints `<code>: <message>` to stderr and exits 1 so operators (and the
install proof `env -i python -m app.main`) see e.g. BAI-120 with the
missing keys instead of a bare traceback. No retries, no defaults.
"""

from __future__ import annotations

import sys

from app.errors import BetterAIError
from app.server import main

if __name__ == "__main__":
    try:
        main()
    except BetterAIError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
