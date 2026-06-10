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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { startServer } from './server/main.js';

// ---- dotenv loader -----------------------------------------------------
//
// Load a local `.env` if one exists, WITHOUT clobbering variables already
// set in the real environment (prod/docker must always win). Node 22's
// `process.loadEnvFile()` throws when the file is absent, so we guard on
// existsSync; it does NOT override already-set process.env entries (verified
// against Node 22), so real-env values take precedence over the file.
//
// Dependency-free on purpose — no `dotenv` package needed.
const dotenvPath = resolve(process.cwd(), '.env');
if (existsSync(dotenvPath)) {
  process.loadEnvFile(dotenvPath);
}
import retrieveContext from './mcp-tools/retrieve-context.js';
import retrieveRules from './mcp-tools/retrieve-rules.js';
import retrieveSkills from './mcp-tools/retrieve-skills.js';
import retrieveMemories from './mcp-tools/retrieve-memories.js';
import checkFile from './mcp-tools/check-file.js';
import explainRule from './mcp-tools/explain-rule.js';
import recordMemory from './mcp-tools/record-memory.js';

await startServer({
  tools: [
    retrieveContext,
    retrieveRules,
    retrieveSkills,
    retrieveMemories,
    checkFile,
    explainRule,
    recordMemory,
  ],
});
