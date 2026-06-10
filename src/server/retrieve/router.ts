// src/server/retrieve/router.ts
//
// Parse `_meta/domain-router.yaml` and apply its rules to a retrieval
// context.  Per the v4 design "Distributed Sub-Corpus Routing": we route
// to DOMAINS, not to individual ids.  Multiple routers union their domain
// sets; the result is capped at `max_total_rules` after per-domain
// capping.

import { existsSync, readFileSync } from "node:fs";

export interface DomainRouterConfig {
  routers: RouterDef[];
  defaults: {
    domains: string[];
    max_rules_per_domain: number;
    max_total_rules: number;
  };
}

export interface RouterDef {
  id: string;
  rules: RouterRule[];
}

export interface RouterRule {
  if_match?: string; // glob over file paths
  if_intent_contains?: string[];
  domains: string[];
}

export interface RouteContext {
  file_paths: string[];
  intent: string;
}

export interface RouteResult {
  domains: string[];
  max_rules_per_domain: number;
  max_total_rules: number;
  /** Which router(s) actually fired, for diagnostics. */
  fired: string[];
}

// ---- YAML loader (intentionally minimal) -------------------------------
//
// The router YAML is small and well-known.  We hand-parse the subset we
// need (key: value, list-of-objects, nested objects) so the Phase 1.0
// scaffold has no YAML dep before Team A locks one in.
//
// TODO(phase-1.1): swap to the `yaml` package once Team A pins it.

interface YamlNode {
  [key: string]: unknown;
}

function loadRouterYaml(path: string): DomainRouterConfig {
  if (!existsSync(path)) {
    return emptyConfig();
  }
  const raw = readFileSync(path, "utf8");
  const tree = parseYaml(raw);
  return normalize(tree);
}

// Single source of truth for the "no router config / key absent" fallback budget.
// Both emptyConfig() (no file) and normalize() (file present, key missing) reference
// these so the two paths cannot silently diverge.
const DEFAULT_ROUTER_DOMAINS = ["maintainability", "methodology"];
const DEFAULT_MAX_RULES_PER_DOMAIN = 4;
const DEFAULT_MAX_TOTAL_RULES = 12;

function emptyConfig(): DomainRouterConfig {
  return {
    routers: [],
    defaults: {
      domains: [...DEFAULT_ROUTER_DOMAINS],
      max_rules_per_domain: DEFAULT_MAX_RULES_PER_DOMAIN,
      max_total_rules: DEFAULT_MAX_TOTAL_RULES,
    },
  };
}

/**
 * Sufficient-for-our-shape YAML reader.  Handles:
 *  - key: scalar
 *  - key: [a, b, c]  (inline list)
 *  - key:\n  - item   (block list of scalars OR objects)
 *  - nested mappings via indentation (2 spaces)
 *
 * Tabs are not handled — domain-router.yaml uses spaces by convention.
 */
function parseYaml(src: string): YamlNode {
  const lines = src
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const [tree, _] = parseBlock(lines, 0, 0);
  return tree as YamlNode;
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

function parseBlock(
  lines: string[],
  i: number,
  parentIndent: number,
): [YamlNode | unknown[], number] {
  let firstIndent = -1;
  // Detect whether this block is a list (starts with "-") or a map.
  for (let j = i; j < lines.length; j += 1) {
    const ind = indentOf(lines[j]);
    if (ind <= parentIndent && j !== i) return [emptyOrFirst()] as never;
    if (ind > parentIndent) {
      firstIndent = ind;
      break;
    }
  }
  if (firstIndent === -1) return [{}, i];
  const isList = lines[i].slice(firstIndent).startsWith("- ");
  if (isList) {
    const items: unknown[] = [];
    while (i < lines.length) {
      const line = lines[i];
      const ind = indentOf(line);
      if (ind < firstIndent) break;
      if (ind === firstIndent && line.slice(ind).startsWith("- ")) {
        // Inline scalar or start of a sub-object on the same line.
        const after = line.slice(ind + 2);
        if (after.includes(":") && !after.startsWith("[")) {
          // Object item — parse this and following indented lines as one map.
          const objLines: string[] = [" ".repeat(firstIndent + 2) + after];
          i += 1;
          while (i < lines.length) {
            const ind2 = indentOf(lines[i]);
            if (ind2 < firstIndent + 2) break;
            if (ind2 === firstIndent && lines[i].slice(ind2).startsWith("- "))
              break;
            objLines.push(lines[i]);
            i += 1;
          }
          const [obj] = parseBlock(objLines, 0, firstIndent + 1);
          items.push(obj);
          continue;
        }
        items.push(parseScalar(after));
        i += 1;
        continue;
      }
      break;
    }
    return [items, i];
  }
  // Map.
  const obj: YamlNode = {};
  while (i < lines.length) {
    const line = lines[i];
    const ind = indentOf(line);
    if (ind < firstIndent) break;
    if (ind > firstIndent) {
      i += 1;
      continue;
    }
    const trimmed = line.slice(ind);
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === "") {
      // Nested block.
      const [child, next] = parseBlock(lines, i + 1, firstIndent);
      obj[key] = child;
      i = next;
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      obj[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => parseScalar(s.trim()))
        .filter((s) => s !== "");
      i += 1;
      continue;
    }
    obj[key] = parseScalar(rest);
    i += 1;
  }
  return [obj, i];
}

function emptyOrFirst(): [unknown, number] {
  return [{}, 0];
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function normalize(tree: YamlNode): DomainRouterConfig {
  const routersRaw = (tree.routers as RouterDef[] | undefined) ?? [];
  const defaultsRaw = (tree.defaults as Partial<
    DomainRouterConfig["defaults"]
  > | undefined) ?? {};
  return {
    routers: routersRaw,
    defaults: {
      domains: defaultsRaw.domains ?? [...DEFAULT_ROUTER_DOMAINS],
      max_rules_per_domain:
        defaultsRaw.max_rules_per_domain ?? DEFAULT_MAX_RULES_PER_DOMAIN,
      max_total_rules: defaultsRaw.max_total_rules ?? DEFAULT_MAX_TOTAL_RULES,
    },
  };
}

// ---- Glob matching (small, dependency-free) ---------------------------

/**
 * Convert a glob pattern to a regex.  Supports `**`, `*`, `?`.  We don't
 * need brace expansion or extglob for the router config; if a future
 * pattern needs them, swap in `picomatch` here.
 */
function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // **
        re += ".*";
        i += 2;
        if (glob[i] === "/") i += 1;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp(re + "$");
}

function pathMatchesAny(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

// ---- Public API --------------------------------------------------------

export class DomainRouter {
  constructor(private readonly config: DomainRouterConfig) {}

  static fromFile(path: string): DomainRouter {
    return new DomainRouter(loadRouterYaml(path));
  }

  route(ctx: RouteContext): RouteResult {
    const matched = new Set<string>();
    const fired: string[] = [];
    const intent = ctx.intent.toLowerCase();

    for (const router of this.config.routers) {
      let routerFired = false;
      for (const rule of router.rules) {
        if (rule.if_match) {
          for (const p of ctx.file_paths) {
            if (pathMatchesAny(p, rule.if_match)) {
              for (const d of rule.domains) matched.add(d);
              routerFired = true;
              break;
            }
          }
        }
        if (rule.if_intent_contains) {
          for (const kw of rule.if_intent_contains) {
            if (intent.includes(kw.toLowerCase())) {
              for (const d of rule.domains) matched.add(d);
              routerFired = true;
              break;
            }
          }
        }
      }
      if (routerFired) fired.push(router.id);
    }

    if (!matched.size) {
      for (const d of this.config.defaults.domains) matched.add(d);
    }

    return {
      domains: [...matched],
      max_rules_per_domain: this.config.defaults.max_rules_per_domain,
      max_total_rules: this.config.defaults.max_total_rules,
      fired,
    };
  }

  get defaults() {
    return this.config.defaults;
  }
}
