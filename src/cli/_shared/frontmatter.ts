/**
 * Minimal YAML frontmatter parser for the BetterAI corpus.
 *
 * Why hand-rolled and not js-yaml: the corpus frontmatter is a deliberately
 * narrow subset — strings, numbers, booleans, simple arrays, simple objects,
 * one level of nesting under `applies_when` / `check`. Hand-rolling keeps
 * the CLI dependency-light and the failure modes legible (we hand back the
 * offending line, not a generic "unexpected token" from a YAML state
 * machine).
 *
 * If the corpus ever needs richer YAML (anchors, multi-doc, complex nesting)
 * the right move is to add js-yaml as a dep, not extend this parser.
 */

export type Frontmatter = Record<string, unknown>;

export interface ParseOk {
  ok: true;
  frontmatter: Frontmatter;
  body: string;
  frontmatterEndLine: number;
}

export interface ParseErr {
  ok: false;
  error: string;
}

export function parseFrontmatter(raw: string): ParseOk | ParseErr {
  const lines = raw.split("\n");
  if (lines[0] !== "---") {
    return { ok: false, error: "missing opening '---' on line 1" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, error: "missing closing '---' for frontmatter" };
  }
  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  try {
    const fm = parseYamlSubset(fmLines);
    return { ok: true, frontmatter: fm, body, frontmatterEndLine: end + 1 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseYamlSubset(lines: string[]): Frontmatter {
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent !== 0) {
      throw new Error(`unexpected indent on line ${i + 2} (top-level keys must start at column 0)`);
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`expected 'key: value' on line ${i + 2}, got: ${line}`);
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest === "" || rest === "|" || rest === ">") {
      // Either a nested object/array follows on the next line(s) OR a multi-line string scalar.
      const isMultilineString = rest === "|" || rest === ">";
      if (isMultilineString) {
        const { value, consumed } = consumeMultilineString(lines, i + 1, rest);
        out[key] = value;
        i = i + 1 + consumed;
        continue;
      }
      // Look ahead for either '- ' (array) or '  key:' (nested object).
      const next = lines[i + 1] ?? "";
      const nextTrim = next.trimStart();
      if (nextTrim.startsWith("- ")) {
        const { value, consumed } = consumeBlockArray(lines, i + 1);
        out[key] = value;
        i = i + 1 + consumed;
      } else if (next.startsWith("  ")) {
        const { value, consumed } = consumeNestedObject(lines, i + 1);
        out[key] = value;
        i = i + 1 + consumed;
      } else {
        out[key] = null;
        i++;
      }
    } else {
      out[key] = parseScalar(rest);
      i++;
    }
  }
  return out;
}

function consumeMultilineString(lines: string[], start: number, marker: string): { value: string; consumed: number } {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === "" || line.startsWith("  ")) {
      collected.push(line.replace(/^ {2}/, ""));
      i++;
    } else {
      break;
    }
  }
  // '|' preserves newlines, '>' folds them. The corpus uses '|' for `when_to_use`.
  const joined = marker === ">" ? collected.join(" ").trim() : collected.join("\n").replace(/\n+$/, "");
  return { value: joined, consumed: i - start };
}

function consumeBlockArray(lines: string[], start: number): { value: unknown[]; consumed: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)- (.*)$/);
    if (!m) break;
    items.push(parseScalar(m[2].trim()));
    i++;
  }
  return { value: items, consumed: i - start };
}

function consumeNestedObject(lines: string[], start: number): { value: Record<string, unknown>; consumed: number } {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("  ")) break;
    const trimmed = line.slice(2);
    if (trimmed.startsWith(" ")) {
      // We only support one level of nesting for the CLI parser; deeper
      // structure is a corpus authoring smell.
      i++;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    if (rest === "") {
      // Inline array on next lines.
      const next = lines[i + 1] ?? "";
      if (next.trimStart().startsWith("- ")) {
        const { value, consumed } = consumeBlockArray(lines, i + 1);
        obj[key] = value;
        i = i + 1 + consumed;
        continue;
      }
      obj[key] = null;
      i++;
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: obj, consumed: i - start };
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  // Inline flow array: [a, b, c]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  // Quoted string.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}
