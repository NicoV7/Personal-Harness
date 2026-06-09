---
id: checkpoint-context-around-compaction
title: Checkpoint structured context around compaction events
category: PROCESS
domain: methodology
severity: medium
created: 2026-06-09
applies_when:
  intents: [context-management]
related: [search-context-before-substantive]
source: RULES.md rule 2
---

## What this rule says

Before a context compaction event, write a structured summary to a persistent location outside the model's context window; after compaction, replay that summary into the new window before resuming work. The summary must contain at minimum: **decisions made and their rationale, open questions still unresolved, files touched (with their paths and a one-line note on each), and the next intended action**. The persistent location is infrastructure-agnostic — a file on disk, a memory entry in the corpus, a row in a database, a scratchpad in a tool. The shape of the summary matters; the storage backend does not.

A compaction event is any moment where the working context window is about to shrink: the LLM's auto-compaction kicks in, the user starts a new session, control hands off to a subagent, or the agent itself elects to drop history to make room. Each of these has the same risk profile: information needed for the next decision is about to disappear, and without an explicit save, that information cannot be recovered.

## Why it matters

Without a checkpoint, post-compaction the agent has the user's original prompt, perhaps a summarized transcript, and nothing else. The decisions made along the way — "we chose Postgres over SQLite because X," "we already tried Y and it broke" — get reduced to whatever the auto-summarizer happened to preserve. The summarizer optimizes for fluency, not retrievability, and routinely drops the exact constraints the agent will need to make the next decision consistent with prior ones.

This produces a class of failure called "context amnesia": post-compaction the agent rederives, rejects, and reproposes the same options the pre-compaction agent already evaluated. The user experiences this as the agent "forgetting" — but the actual cost is that decisions get relitigated, and the second pass may quietly contradict the first because the rationale never made it across the boundary.

## When this applies

- Token budget at or above 70% of the context window — compaction is imminent.
- Handoff to a subagent or a new conversation: the receiver has none of the in-flight context.
- End of a working session where the next session will pick up the same task.
- Before invoking a long-running tool that will emit a large output (which will itself push toward compaction).
- Any time the agent is about to elect to drop history to make room.

It does NOT apply to routine reads within a comfortable token budget, or to one-shot tasks where there is no "after."

## What good looks like

A checkpoint is a small structured object written before compaction and read after. The shape is the same regardless of where it lands.

```typescript
type Checkpoint = {
  task: string;                 // the user's original ask, one sentence
  decisions: {
    what: string;               // "Use Postgres for the rule corpus"
    why: string;                // "JSONL on disk loses ACID on concurrent writes"
    when: string;               // ISO timestamp
  }[];
  open_questions: string[];     // questions the agent still needs answered
  files_touched: {
    path: string;
    note: string;               // "added retrieve_rules() handler"
  }[];
  next_action: string;          // exactly what the agent intended to do next
};

// Write before compaction:
await fs.writeFile(
  ".betterai/checkpoint-2026-06-09.json",
  JSON.stringify(checkpoint, null, 2),
);

// Read after compaction (first action in new context):
const prior = JSON.parse(
  await fs.readFile(".betterai/checkpoint-2026-06-09.json", "utf8"),
);
// Then state in the visible response: "Resuming from checkpoint. Prior decisions: …"
```

## Anti-patterns

**Wrong:** Trust the auto-compactor to preserve what matters.

```typescript
// Agent does 90% of the work in one long session, never writes a checkpoint.
// Auto-compaction fires. The summary drops the rationale for choosing Postgres.
// Post-compaction, agent proposes "let's just use SQLite, simpler."
// User has to re-explain why they ruled out SQLite an hour ago.
```

**Fixed:** Write a checkpoint at token-budget thresholds, replay it after compaction.

```typescript
// At 70% budget: agent writes checkpoint.json with decisions + open questions.
// Compaction fires, possibly drops most history.
// First action in new window: read checkpoint, print "Resuming with prior decisions: [list]."
// Decisions remain consistent across the boundary; user is never asked to re-decide.
```

## Examples

The persistent location is deliberately unspecified. In BetterAI v1 the natural location is a memory entry in `memories/<yyyy-mm>/` with `kind=decision` and `durability=medium`, which makes the checkpoint also a retrievable artifact for future sessions. In a project without BetterAI integration, a plain JSON file in the repo's working directory or in `.scratch/` is fine. What matters is that the checkpoint survives the compaction event and is read before the next substantive action.

A common failure mode is writing the checkpoint but forgetting to read it. Pair the write with an explicit "first action after resumption" — the resumed agent's very first tool call should be reading the most recent checkpoint, not jumping straight to the next task.
