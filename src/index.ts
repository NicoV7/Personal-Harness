// BetterAI server entrypoint.
//
// Phase 1.0 (Wave 3) scaffold: this file is a thin shim. All bootstrap logic
// — transport registration, bearer-token middleware, MCP tool dispatch,
// corpus reader wiring, audit pipe — lives in src/server/main.ts (Team B's
// slice). Keeping the entrypoint trivial means the Dockerfile CMD never has
// to change as the server grows.
//
// Per .betterai/rules/STANDARDS/maintainability/no-stdio-mcp-transport.md:
// there is ONE transport (HTTP/SSE on 127.0.0.1:7777). Do not add a stdio
// path here, do not add an env-gated fallback. The CLI shim talks HTTP too.

import { startServer } from './server/main.js';

await startServer();
