/**
 * betterai init [--seed]
 *
 * Scaffold ~/.betterai/ on the host and (if --seed) copy the bundled
 * seed corpus from /opt/betterai/seed-corpus into it, including the
 * welcome-task README (DX-FIX-1).
 *
 * Idempotent: running twice does not clobber existing files.
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const REQUIRED_SUBDIRS = ["rules", "skills", "memories", "audit", "embeddings", "welcome-task"];

export function runInit(args: string[]): number {
  const seed = args.includes("--seed");
  const home = process.env.HOME ?? homedir();
  const betteraiDir = process.env.BETTERAI_HOME ?? join(home, ".betterai");

  process.stdout.write(`betterai init: scaffolding ${betteraiDir}\n`);

  ensureDir(betteraiDir);
  for (const sub of REQUIRED_SUBDIRS) {
    ensureDir(join(betteraiDir, sub));
  }

  // README marker file, idempotent.
  const readme = join(betteraiDir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      "# ~/.betterai\n\nLocal corpus for the BetterAI context moat. Manage via `betterai` CLI.\n",
      "utf8",
    );
  }

  if (seed) {
    const seedSrc = locateSeedCorpus();
    if (!seedSrc) {
      process.stderr.write(
        "betterai init --seed: no seed corpus found at /opt/betterai/seed-corpus or ./seed-corpus\n",
      );
      return 1;
    }
    process.stdout.write(`betterai init: seeding from ${seedSrc}\n`);
    copyTree(seedSrc, betteraiDir, { skipExisting: true });
  }

  process.stdout.write("betterai init: done\n");
  process.stdout.write(`  next: ${seed ? "cat " + join(betteraiDir, "welcome-task", "README.md") : "betterai init --seed"}\n`);
  return 0;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  } else if (!statSync(p).isDirectory()) {
    throw new Error(`${p} exists and is not a directory`);
  }
}

function locateSeedCorpus(): string | null {
  const candidates = [
    process.env.BETTERAI_SEED_CORPUS,
    "/opt/betterai/seed-corpus",
    resolve(process.cwd(), "seed-corpus"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return null;
}

function copyTree(src: string, dst: string, opts: { skipExisting: boolean }): void {
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const st = statSync(s);
    if (st.isDirectory()) {
      ensureDir(d);
      copyTree(s, d, opts);
    } else {
      if (opts.skipExisting && existsSync(d)) continue;
      ensureDir(dirname(d));
      copyFileSync(s, d);
    }
  }
}

// Re-export for tests / programmatic use.
export const __internal = { ensureDir, locateSeedCorpus, copyTree };
