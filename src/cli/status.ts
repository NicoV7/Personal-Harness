/**
 * betterai status [--offline]
 *
 * Shows global + repo corpus counts and recent activity from the audit
 * JSONL log. In --offline mode we read disk only (no MCP calls) per
 * .betterai/rules/STANDARDS/maintainability/cli-read-ops-work-offline.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectRepoRoot } from "./_shared/repo-root.js";

interface CorpusCounts {
  rules: number;
  skills: number;
  memories: number;
}

export function runStatus(args: string[]): number {
  const offline = args.includes("--offline");
  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const repoRoot = detectRepoRoot(process.cwd());

  const globalCounts = countCorpus(globalRoot);
  process.stdout.write(
    `[GLOBAL] ${globalRoot}\n` +
      `         ${globalCounts.rules} rules / ${globalCounts.skills} skills / ${globalCounts.memories} memories\n`,
  );

  if (repoRoot) {
    const repoCorpus = join(repoRoot, ".betterai");
    if (existsSync(repoCorpus)) {
      const repoCounts = countCorpus(repoCorpus);
      process.stdout.write(
        `[REPO]   ${repoCorpus}\n` +
          `         ${repoCounts.rules} rules / ${repoCounts.skills} skills / ${repoCounts.memories} memories\n`,
      );
    } else {
      process.stdout.write(`[REPO]   none at ${repoCorpus}\n`);
    }
  } else {
    process.stdout.write(`[REPO]   not in a git repo\n`);
  }

  // Audit recent activity. Offline reads on-disk JSONL directly; online mode
  // would call the MCP server for live override stats — Phase 1.0 keeps both
  // paths reading the same file because the MCP server is the producer.
  const auditPath = process.env.BETTERAI_AUDIT_PATH ?? join(globalRoot, "audit", "audit.jsonl");
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const total = lines.length;
    const last5 = lines.slice(-5);
    process.stdout.write(`\n[AUDIT]  ${auditPath}\n         ${total} event(s) total\n`);
    if (last5.length > 0) {
      process.stdout.write(`         recent:\n`);
      for (const line of last5) {
        try {
          const evt = JSON.parse(line);
          process.stdout.write(
            `           ${evt.ts ?? "?"} ${evt.event_type ?? "?"} ` +
              `(${(evt.rules_returned ?? []).length} returned, ` +
              `${(evt.overridden_global_ids ?? []).length} overridden)\n`,
          );
        } catch {
          process.stdout.write(`           <unparseable line>\n`);
        }
      }
    }
  } else {
    process.stdout.write(`\n[AUDIT]  ${auditPath}: no events yet\n`);
  }

  if (!offline) {
    process.stdout.write(
      `\nnote: live MCP queries are deferred to Phase 1.1. ` +
        `For now 'status' and 'status --offline' read the same on-disk state.\n`,
    );
  }
  return 0;
}

function countCorpus(root: string): CorpusCounts {
  return {
    rules: countMarkdown(join(root, "rules")),
    skills: countMarkdown(join(root, "skills")),
    memories: countMarkdown(join(root, "memories")),
  };
}

function countMarkdown(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      n += countMarkdown(p);
    } else if (entry.endsWith(".md") && !entry.startsWith("_")) {
      n++;
    }
  }
  return n;
}
