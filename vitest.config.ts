import { defineConfig } from "vitest/config";

// BetterAI v1.0 test runner config. Deliberately minimal:
// - one test glob (src/__tests__/**) covering both integration tests AND the
//   validator's own colocated tests
// - node environment (the server is node-only; no jsdom needed)
// - no coverage in v1 — phase 1.0 is wedge code, coverage gates land at 1.5
// See docs/IMPLEMENTATION-ROADMAP.html and rules/STANDARDS/maintainability/simplicity-first.md.
export default defineConfig({
  test: {
    include: [
      "src/__tests__/**/*.test.ts",
      "src/_meta-validators/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // No coverage provider configured for v1.
    // No globals — every test imports describe/test/expect explicitly.
    globals: false,
  },
});
