---
id: alt-text-required
title: Every img has alt text; decorative images use empty alt
category: STANDARDS
domain: accessibility
severity: high
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
    - accessibility
related:
  - semantic-html-default
check:
  kind: regex
  pattern: "<img(?:(?!\\salt=)[^>])*>"
  notes: "Flags an <img> with no alt attribute. Informative images get descriptive alt; purely decorative images get alt=\"\" (empty, not omitted)."
---

## What this rule says

Every `<img>` carries an `alt` attribute. Informative images get a concise description of their content/purpose; purely decorative images get `alt=""` (present but empty) so assistive tech skips them. Omitting `alt` entirely is never correct — screen readers then read the file name.

## Why it matters

- **Accessibility (WCAG 1.1.1):** non-text content must have a text alternative; a missing `alt` makes a portfolio unusable to screen-reader users and fails the most basic audit.
- **Resilience:** if an image fails to load, `alt` is what the user sees.
- **SEO:** alt text is indexed.

## What good looks like

```html
<img src="headshot.jpg" alt="Nico, smiling, in front of a bookshelf">
<img src="divider.svg" alt="">  <!-- decorative -->
```

## Anti-pattern

```html
<img src="headshot.jpg">                 <!-- no alt: screen reader reads "headshot dot jpg" -->
<img src="divider.svg" alt="divider">    <!-- decorative image announced as noise -->
```

## Related

- `[[semantic-html-default]]` — landmarks + alt text are the floor of an accessible page.
