/**
 * betterai replay --since 7d
 *
 * Per DX-FIX-18: weekly audit-log digest. Reads the audit JSONL on disk
 * and emits totals, top-fired rules, missed-retrieval count, and
 * "rules that haven't fired in 30d" (pruning candidates).
 *
 * Runs offline.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectRepoRoot } from "./_shared/repo-root.js";
import { parseFrontmatter } from "./_shared/frontmatter.js";
import { DEFAULT_DIGEST_DAYS, MS_PER_DAY } from "../constants/cli.js";

interface AuditEvent {
  event_type: string;
  ts: string;
  rules_returned?: Array<{ id: string; kind: string; scope: string }>;
  overridden_global_ids?: string[];
  latency_ms?: number;
}

export function runReplay(args: string[]): number {
  // Default to 7 days; accept --since 7d / 14d / 30d.
  let sinceDays = DEFAULT_DIGEST_DAYS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") {
      const v = args[++i] ?? "";
      const m = v.match(/^(\d+)d$/);
      if (!m) {
        process.stderr.write(`replay: --since expects '<N>d' (e.g. '7d'), got '${v}'\n`);
        return 2;
      }
      sinceDays = Number(m[1]);
    }
  }

  const home = process.env.HOME ?? homedir();
  const globalRoot = process.env.BETTERAI_HOME ?? join(home, ".betterai");
  const auditPath = process.env.BETTERAI_AUDIT_PATH ?? join(globalRoot, "audit", "audit.jsonl");

  if (!existsSync(auditPath)) {
    process.stdout.write(`replay: no audit log at ${auditPath} — nothing to digest yet.\n`);
    return 0;
  }

  const cutoff = Date.now() - sinceDays * MS_PER_DAY;
  const events = readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => safeParse(l))
    .filter((e): e is AuditEvent => e !== null)
    .filter((e) => Date.parse(e.ts) >= cutoff);

  process.stdout.write(`\nbetterai replay (last ${sinceDays}d, ${events.length} event(s))\n`);
  process.stdout.write(`${"─".repeat(60)}\n\n`);

  const byType = new Map<string, number>();
  const ruleFireCount = new Map<string, number>();
  let totalLatency = 0;
  let latencyN = 0;
  let totalOverrides = 0;
  let missedRetrievals = 0;
  for (const e of events) {
    byType.set(e.event_type, (byType.get(e.event_type) ?? 0) + 1);
    if (e.event_type === "missed_retrieval") missedRetrievals++;
    if (typeof e.latency_ms === "number") {
      totalLatency += e.latency_ms;
      latencyN++;
    }
    totalOverrides += (e.overridden_global_ids ?? []).length;
    for (const r of e.rules_returned ?? []) {
      const key = `${r.kind}:${r.id}`;
      ruleFireCount.set(key, (ruleFireCount.get(key) ?? 0) + 1);
    }
  }

  process.stdout.write(`Events by type:\n`);
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${t.padEnd(22)} ${n}\n`);
  }

  process.stdout.write(`\nTop fired artifacts:\n`);
  const top = [...ruleFireCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const [k, n] of top) {
      process.stdout.write(`  ${String(n).padStart(4)} × ${k}\n`);
    }
  }

  if (latencyN > 0) {
    process.stdout.write(`\nLatency: avg ${(totalLatency / latencyN).toFixed(1)} ms over ${latencyN} call(s)\n`);
  }
  process.stdout.write(`Missed retrievals: ${missedRetrievals}\n`);
  process.stdout.write(`Overrides applied: ${totalOverrides}\n`);

  // "Pruning candidates" — rules in the corpus that fired 0 times in the window.
  const allIds = collectAllIds(globalRoot, detectRepoRoot(process.cwd()));
  const stale = [...allIds].filter((k) => !ruleFireCount.has(k));
  if (stale.length > 0) {
    process.stdout.write(`\nPruning candidates (no fires in last ${sinceDays}d): ${stale.length}\n`);
    for (const k of stale.slice(0, 10)) {
      process.stdout.write(`  ${k}\n`);
    }
    if (stale.length > 10) process.stdout.write(`  ... and ${stale.length - 10} more\n`);
  }
  return 0;
}

function safeParse(line: string): AuditEvent | null {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return null;
  }
}

function collectAllIds(globalRoot: string, repoRoot: string | null): Set<string> {
  const ids = new Set<string>();
  const roots: string[] = [];
  if (existsSync(globalRoot)) roots.push(globalRoot);
  if (repoRoot && existsSync(join(repoRoot, ".betterai"))) roots.push(join(repoRoot, ".betterai"));
  for (const root of roots) {
    for (const [kind, sub] of [["rule", "rules"], ["skill", "skills"], ["memory", "memories"]] as const) {
      const dir = join(root, sub);
      if (!existsSync(dir)) continue;
      for (const file of walkMarkdown(dir)) {
        try {
          const parsed = parseFrontmatter(readFileSync(file, "utf8"));
          if (parsed.ok && typeof parsed.frontmatter.id === "string") {
            ids.add(`${kind}:${parsed.frontmatter.id}`);
          }
        } catch {
          // Skip — validate.ts is the right place for these errors.
        }
      }
    }
  }
  return ids;
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkMarkdown(p);
    else if (entry.endsWith(".md") && !entry.startsWith("_")) yield p;
  }
}
