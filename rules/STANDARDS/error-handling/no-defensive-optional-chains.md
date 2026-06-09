---
id: no-defensive-optional-chains
title: Don't defend against your own data shape with deep optional chains and || fallbacks
category: STANDARDS
domain: error-handling
severity: medium
created: 2026-06-09
applies_when:
  paths: ["**/*.ts", "**/*.js", "**/*.py"]
  intents: ["defensive-programming", "data-validation", "schema-modeling"]
check:
  kind: ast-grep
  pattern: "$X?.$A?.$B?.$C?.$D"
related:
  - no-catch-all-exception-masking
  - no-redundant-internal-validation
source: RULES.md §4.2
---

## What this rule says

If you find yourself writing `a?.b?.c?.d?.e || "Default"` to read a value out of a structure you control, the bug is not at the read site — it is at the boundary where the structure entered your program without being validated.

Stop hardening every read site. Validate once at the boundary (HTTP response, queue message, file load, third-party SDK call) with a schema validator like Zod, and let every internal call site read fields directly. If the boundary fails, you get *one* clear error pointing at the actual contract violation; if individual reads are defended, you get silent `"Default"` everywhere and no idea which upstream field is wrong.

This is a corollary of "make illegal states unrepresentable". A field that is "sometimes there" is not a real field; it is two fields hiding as one.

## Why it matters

Deep optional chains look harmless — they "just" prevent a crash. They cause four real problems:

- **Hidden contract drift.** Vendor changes `theme.title` to `theme.label`. The chain quietly returns `"Default"` forever. No one notices until a designer asks why every card shows "Default".
- **Type erosion.** `theme?.title || "Default"` types as `string`, so the call site has no idea whether it got real data or fallback. The "real or fallback" distinction is the one your downstream code most often needs.
- **Repetition without truth.** Five call sites each pick a different fallback (`"Default"`, `"Untitled"`, `""`, `null`, `"Unknown"`). Now you have five contracts for the same field.
- **Encourages more defense.** Each new property added to the path adds another `?.`, and the tax compounds. Validation at the boundary is paid once.

`severity: medium` because the failure is usually wrong-but-running rather than crashed-and-loud — recoverable, but corrosive.

## When this applies

Applies when:

- A chain of three or more optional accesses (`a?.b?.c?.d`) reads from data your code owns or fetches, AND
- The chain ends in a `|| <literal>` or `?? <literal>` fallback, AND
- No schema validator (Zod, Valibot, ArkType, pydantic, etc.) gates the data at the boundary.

Does NOT apply when:

- The chain reads from a genuinely optional structure (a config that legitimately may not have a `theme` block), and the fallback is a documented domain default, OR
- You are interoperating with a truly dynamic source (JSON-LD payload, user-pasted markdown frontmatter) where shape *is* the unknown.

## What good looks like

Validate once at the edge. Read directly inside.

```typescript
import { z } from "zod";

// Boundary: define the shape exactly once.
const DashboardResponseSchema = z.object({
  data: z.object({
    user: z.object({
      profile: z.object({
        settings: z.object({
          theme: z.object({
            title: z.string(),
          }),
        }),
      }),
    }),
  }),
});
type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

async function fetchDashboard(userId: string): Promise<DashboardResponse> {
  const raw = await api.get(`/dashboard/${userId}`);
  // One place to fail. One place to log. One place to fix when the API drifts.
  return DashboardResponseSchema.parse(raw);
}

// Every call site is now boring:
function renderTitle(response: DashboardResponse): string {
  return response.data.user.profile.settings.theme.title;
}
```

If the field is *genuinely* optional in the domain, model it as optional in the schema and handle it explicitly — not with `||`:

```typescript
const SettingsSchema = z.object({
  theme: z.object({ title: z.string() }).optional(),
});

function renderTitle(settings: z.infer<typeof SettingsSchema>): string {
  if (!settings.theme) return getDefaultTitle(); // explicit domain choice
  return settings.theme.title;
}
```

## Anti-patterns

The original example from `RULES.md §4.2`:

```javascript
// Defending against data that "shouldn't" be missing internally.
const title = response?.data?.user?.profile?.settings?.theme?.title || "Default";
```

The problems:

1. `response` is the result of *your own* API call. Either it is shaped or your fetch failed.
2. If any segment is missing, you cannot tell *which* one. `"Default"` is the same answer for "user is null" and "theme.title is empty string".
3. `|| "Default"` also fires when `title === ""`, which is a different bug.
4. The next field someone reads gets the same five `?.`s, copy-pasted, drifting.

The fix is to parse the response *once* and read normally:

```typescript
const response = DashboardResponseSchema.parse(rawResponse);
const title = response.data.user.profile.settings.theme.title;
```

Sibling anti-pattern — the `??` variant is no better, just newer:

```typescript
const title = response?.data?.user?.profile?.settings?.theme?.title ?? "Default";
// Still six optional accesses against data you fetched. Still no error if the API broke.
```

## Examples

A realistic before/after for a typical TS service file:

```typescript
// BAD — every consumer defends itself.
function getCardTitle(card: any): string {
  return card?.content?.header?.title || "Untitled";
}
function getCardSubtitle(card: any): string {
  return card?.content?.header?.subtitle || "";
}
function getCardAuthor(card: any): string {
  return card?.meta?.author?.name || "Unknown";
}

// GOOD — one schema, three honest reads.
const CardSchema = z.object({
  content: z.object({
    header: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
    }),
  }),
  meta: z.object({
    author: z.object({ name: z.string() }).nullable(),
  }),
});
type Card = z.infer<typeof CardSchema>;

function getCardTitle(card: Card): string { return card.content.header.title; }
function getCardSubtitle(card: Card): string | undefined { return card.content.header.subtitle; }
function getCardAuthor(card: Card): string | null { return card.meta.author?.name ?? null; }
```

The good version is shorter, type-safe, and makes the optional fields visible in the signatures so callers must decide what to do.
