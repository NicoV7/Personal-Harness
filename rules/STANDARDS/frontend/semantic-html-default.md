---
id: semantic-html-default
title: Use semantic HTML landmarks, not div soup
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
  - alt-text-required
  - no-inline-styles
check:
  kind: regex
  pattern: "<div[^>]*class=\"[^\"]*(header|nav|footer|main|article|section)[^\"]*\""
  notes: "Flags a div styled as a landmark where a semantic element belongs. Allow with `<!-- allow-div: <reason> -->`."
---

## What this rule says

Structure every page with semantic landmark elements — `<header>`, `<nav>`, `<main>`, `<section>`, `<article>`, `<footer>` — instead of generic `<div>`s with landmark-ish class names. One `<main>` per page; headings (`<h1>`–`<h6>`) in order without skipping levels.

## Why it matters

- **Accessibility:** screen readers and assistive tech navigate by landmarks; `<div class="nav">` is invisible to them, `<nav>` is a first-class waypoint.
- **SEO + machine parsing:** crawlers and the repo's own architecture-map tooling extract structure from semantic tags.
- **Readability:** `<footer>` says what it is; `<div class="footer-wrapper-2">` does not.

## What good looks like

```html
<header><nav aria-label="Primary">…</nav></header>
<main>
  <section aria-labelledby="about"><h2 id="about">About</h2>…</section>
</main>
<footer>…</footer>
```

## Anti-pattern

```html
<div class="header"><div class="nav">…</div></div>
<div class="main">…</div>
<div class="footer">…</div>
```

## Related

- `[[alt-text-required]]` — the other half of an accessible page.
- `[[no-inline-styles]]` — keep presentation out of the markup.
