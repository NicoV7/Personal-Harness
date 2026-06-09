# BetterAI welcome task

Welcome. This task exists to give you a *magical moment* on your first day with
BetterAI: a single copy-paste prompt that is deliberately engineered to fire at
least three seed rules and produce visibly different output than an
unconfigured Claude Code run. If you can see that difference, the moat is
working — and you'll know what to look for the next time you wonder whether
retrieval fired.

The whole exercise takes about 90 seconds.

## What you'll do

1. **Open a second terminal** and tail the audit log:

   ```sh
   tail -f ~/.betterai/audit/audit.jsonl
   ```

2. **Paste this prompt into Claude Code** (with the BetterAI MCP server connected):

   > Refactor `src/webhooks/stripe.ts` to add an idempotency key check, log the
   > full event id on every retry, and emit a metric on rejection. Don't change
   > the surrounding handler signature. Write secure, observable, idempotent
   > code.

3. **Watch the audit log.** Within a few seconds you should see at least three
   `retrieve` events with `rules_returned` containing rules from at least these
   three seed domains:

   - `STANDARDS/security/*` — bearer-token, secret-handling, PII-in-logs
   - `STANDARDS/observability/*` — context-hash, parent-session-id, log shape
   - `STANDARDS/error-handling/*` — no broad catches, idempotency keys

4. **Compare with the corpus off.** If you want a side-by-side, disconnect the
   MCP server and re-issue the same prompt. The corpus-on version should:

   - Explicitly cite which rules it's following (rule ids by name).
   - Add a dedupe lookup before doing any side effect.
   - Log with structured fields, not free text.
   - Surface any unresolved conflict between a rule and a memory in its plan.

## Success criterion

You have a working installation when **both** of the following are true:

1. The audit log shows **≥3 rules retrieved** for this prompt.
2. Claude's generated code is **visibly different** from a corpus-off run —
   structured logs, an idempotency-key check, and at least one rule cited by id.

If either fails, run `betterai status` and `betterai why "refactor the stripe
webhook handler" --context src/webhooks/stripe.ts`. The `why` command will
show you exactly which artifacts the router considered and why each one did or
did not match.

## Why this prompt fires so many rules

The prompt is engineered: it names three high-severity rule domains
(`idempotency`, `observability`, `security`) and a concrete TypeScript file
path. Path-glob matches in `applies_when` and keyword matches in the
domain-router both fire, and the rules outrank each other on severity rather
than colliding — so you see a *cooperative* retrieval, which is the happy
path of the system. After you've seen this once, you'll recognize the pattern
in your own day-to-day prompts.
