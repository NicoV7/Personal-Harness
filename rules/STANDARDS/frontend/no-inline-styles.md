---
id: no-inline-styles
title: No inline style attributes; keep presentation in a stylesheet
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
    - css
related:
  - semantic-html-default
  - responsive-viewport-meta
check:
  kind: regex
  pattern: "<[a-zA-Z][^>]*\\sstyle="
  notes: "Flags inline style= attributes. Allow a rare dynamic value with `<!-- allow-inline-style: <reason> -->`."
---

## What this rule says

Presentation lives in a stylesheet (an external `.css` file or a single `<style>` block in `<head>`), addressed by class — not in per-element `style="…"` attributes scattered through the markup.

## Why it matters

- **One source of truth:** a color or spacing change happens once in CSS, not by grepping every element.
- **Consistency:** classes enforce a design system; inline styles drift element-by-element.
- **Caching + size:** external CSS is cached across pages; inline styles bloat every document.
- **Specificity wars:** inline styles beat almost everything, so overriding them later means `!important` cascades.

## What good looks like

```html
<a class="btn btn--primary" href="#contact">Contact</a>
```
```css
.btn { padding: 0.6rem 1.2rem; border-radius: 0.5rem; }
.btn--primary { background: var(--accent); color: #fff; }
```

## Anti-pattern

```html
<a style="padding:0.6rem 1.2rem;background:#3b82f6;color:#fff" href="#contact">Contact</a>
```

## Related

- `[[semantic-html-default]]`, `[[responsive-viewport-meta]]`
