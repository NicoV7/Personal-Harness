---
id: responsive-viewport-meta
title: Every HTML document declares a responsive viewport meta tag
category: STANDARDS
domain: frontend
severity: medium
created: 2026-06-10
applies_when:
  paths:
    - "**/*.html"
    - "**/*.tsx"
    - "**/*.jsx"
  intents:
    - website
    - portfolio
    - frontend
    - ui
    - design
    - html
related:
  - semantic-html-default
  - no-inline-styles
check:
  kind: regex
  pattern: "<head>(?:(?!viewport)[\\s\\S])*?</head>"
  notes: "Flags a <head> with no viewport meta. Pair with a responsive layout (relative units, media queries / fluid grid), not a fixed pixel width."
---

## What this rule says

Every HTML document includes `<meta name="viewport" content="width=device-width, initial-scale=1">` in its `<head>`, and the layout is actually responsive — relative units (`rem`, `%`, `clamp()`), a fluid grid or flexbox/grid, and media queries where needed. A viewport tag on a fixed 960px layout is a half-measure.

## Why it matters

- Without the viewport meta, mobile browsers render at a desktop width and zoom out — text is unreadable, the portfolio looks broken on a phone.
- It is one line and it is the single highest-leverage mobile-correctness fix.

## What good looks like

```html
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>…</title>
</head>
```

```css
.container { width: min(72rem, 100%); margin-inline: auto; }
@media (max-width: 40rem) { .grid { grid-template-columns: 1fr; } }
```

## Related

- `[[semantic-html-default]]`, `[[no-inline-styles]]`
