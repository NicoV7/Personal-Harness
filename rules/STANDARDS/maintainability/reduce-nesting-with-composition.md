---
id: reduce-nesting-with-composition
title: Reduce nesting with inversion, named functions, and composition
category: STANDARDS
domain: maintainability
severity: high
created: 2026-06-17
applies_when:
  paths:
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.py"
  intents:
    - implement
    - refactor
    - fix
    - review
related:
  - simplicity-first
  - surgical-changes
  - no-god-files
---

## What this rule says

After the first working implementation, run a clean-code pass that reduces
nested code and duplication before you finish.

Use inversion to make the happy path obvious: guard clauses, early returns, and
early `continue` statements should remove avoidable `else` blocks and nested
conditionals. Extract complex branches into small functions whose names explain
the intent. Prefer names that let a reader understand the code without replaying
the implementation line by line.

When reducing redundancy, prefer composition: shared behavior should be a
function, helper object, or small module that callers assemble. Introduce
inheritance only when there is an existing hierarchy or a real polymorphic
contract that needs it.

## Why it matters

Deep nesting hides the main path, makes error handling easy to miss, and pushes
readers into simulating the whole function in their head. AI-generated code
often works on the first pass but leaves behind pyramids of `if` statements,
large mixed-purpose functions, and generic names such as `data`, `result`, or
`handleThing`.

Composition keeps shared behavior visible at the call site. Inheritance spreads
behavior across files and lifecycle methods, so it carries a higher reading and
testing cost. That cost is only worth paying when the domain already has true
substitutability.

## When this applies

- A function has nesting deeper than three levels.
- A function mixes validation, lookup, transformation, persistence, and output
  formatting in one body.
- Two branches or call sites duplicate logic that can be named once.
- A class hierarchy appears only to share a few helper methods.
- A variable or function name describes shape (`item`, `obj`, `handle`) instead
  of domain intent.

Does NOT apply when flattening would hide the domain sequence, or when a
framework requires an inherited class shape.

## What good looks like

Inversion keeps invalid cases at the edge and gives the main path one level of
indentation:

```ts
export function selectSkill(matches: SkillMatch[], requestedId: string): SkillMatch {
  if (!requestedId.trim()) {
    throw new Error("skill id is required");
  }

  const selected = matches.find((match) => match.id === requestedId);
  if (!selected) {
    throw new Error(`skill not found: ${requestedId}`);
  }

  return selected;
}
```

Extraction names a branch that would otherwise need comments:

```ts
function shouldBlockOrdinaryTool(state: ReadGateState, toolName: string): boolean {
  return hasUnreadRequiredSkills(state) && !isBetterAiBootstrapTool(toolName);
}
```

Composition shares behavior without a hierarchy:

```ts
const codexAdapter = createClientAdapter({
  name: "codex",
  configPath: codexConfigPath,
  install: writeCodexConfig,
  uninstall: removeCodexConfig,
});
```

## Anti-patterns

Nested control flow that makes the success case the innermost branch:

```ts
if (session) {
  if (session.required.length > 0) {
    if (!session.read.includes(skillId)) {
      if (!isBootstrapTool(toolName)) {
        return block(toolName);
      }
    }
  }
}
return allow();
```

Fix it by inverting conditions into named checks:

```ts
if (!hasUnreadRequiredSkills(session)) return allow();
if (isBootstrapTool(toolName)) return allow();
return block(toolName);
```

Inheritance used only to reuse helpers:

```ts
abstract class ClientAdapterBase {
  protected replaceBlock() {}
  protected writeJson() {}
}
class CodexAdapter extends ClientAdapterBase {}
class ClaudeAdapter extends ClientAdapterBase {}
```

Fix it by composing shared helpers into plain adapter functions or objects.

## Examples

Before completing any non-trivial code change, scan the touched functions:

1. If a branch is nested because it handles an exceptional case, invert it.
2. If a block needs a comment to explain what it does, extract it behind a clear
   function name.
3. If two sites repeat logic, compose them around one named helper.
4. If inheritance appeared only to share code, replace it with composition.
