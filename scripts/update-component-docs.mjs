#!/usr/bin/env node
// Auto-update docs/components/*.html with a "Recent commits" section per touched component.
// Invoked by .githooks/pre-commit (and manually via `npm run docs:stamp`).
//
// Strategy:
//   1. Read staged files (or files from git log -1, depending on mode).
//   2. Map each file to a component using PATH_TO_COMPONENT below.
//   3. For each touched component HTML, ensure it has the
//      <!-- AUTOSTAMP:RECENT-COMMITS:START --> ... :END --> markers.
//      Insert the section right before the page footer if missing.
//   4. Prepend a new row inside the markers. Cap at 10 rows.
//   5. Re-stage modified docs.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = resolve(REPO, 'docs/components')
const MAX_ROWS = 10

// Path-prefix → component name. Longest prefix wins.
// Keep in sync with docs/components/index.html.
const PATH_TO_COMPONENT = [
  ['src/server/corpus/', 'corpus'],
  ['src/server/retrieve/', 'retrieve'],
  ['src/server/cache/', 'cache'],
  ['src/server/audit/', 'audit'],
  ['src/server/scope/', 'scope'],
  ['src/server/transport/', 'transport'],
  ['src/server/auth/', 'auth'],
  ['src/server/main.ts', 'transport'],
  ['src/server/', 'transport'],
  ['src/mcp-tools/', 'mcp-tools'],
  ['src/cli/', 'cli'],
  ['bin/betterai', 'cli'],
  ['install.sh', 'install'],
  ['Dockerfile', 'install'],
  ['docker-compose.yml', 'install'],
  ['seed-corpus/', 'install'],
  ['rules/', 'corpus'],
  ['skills/', 'corpus'],
  ['memories/', 'corpus'],
  ['.betterai/rules/', 'corpus'],
  ['src/_meta-validators/', 'corpus'],
  ['src/__tests__/', '_skip'], // tests don't bump a component
  ['src/index.ts', 'transport'],
  ['package.json', '_skip'],
  ['tsconfig.json', '_skip'],
  ['vitest.config.ts', '_skip'],
]

function pickComponent(file) {
  let best = null
  for (const [prefix, comp] of PATH_TO_COMPONENT) {
    if (file === prefix || file.startsWith(prefix)) {
      if (!best || prefix.length > best.prefix.length) best = { prefix, comp }
    }
  }
  return best?.comp ?? null
}

function sh(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: 'utf8' }).trim()
}

function getStagedFiles() {
  try {
    return sh('git diff --cached --name-only --diff-filter=ACMR').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getLastCommitFiles() {
  try {
    return sh('git diff-tree --no-commit-id --name-only -r HEAD').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getCurrentCommitMeta(staged) {
  // For pre-commit: there's no commit yet. Use HEAD + a placeholder.
  // For post-commit (or `npm run docs:stamp`): use HEAD.
  if (staged) {
    return {
      sha: 'staging',
      date: new Date().toISOString().slice(0, 10),
      subject: 'pending commit (staged changes)',
    }
  }
  return {
    sha: sh('git rev-parse --short HEAD'),
    date: sh('git log -1 --format=%cs HEAD'),
    subject: sh('git log -1 --format=%s HEAD').slice(0, 120),
  }
}

const START = '<!-- AUTOSTAMP:RECENT-COMMITS:START -->'
const END = '<!-- AUTOSTAMP:RECENT-COMMITS:END -->'

function ensureSection(html) {
  if (html.includes(START) && html.includes(END)) return html
  const section = [
    '',
    '<h2>Recent commits</h2>',
    START,
    '<table><thead><tr><th>Date</th><th>SHA</th><th>Subject</th></tr></thead><tbody>',
    '</tbody></table>',
    END,
    '',
  ].join('\n')
  // Insert right before the page footer (the last <div class="footer">).
  const footerIdx = html.lastIndexOf('<div class="footer">')
  if (footerIdx === -1) return html + section
  return html.slice(0, footerIdx) + section + '\n' + html.slice(footerIdx)
}

function prependRow(html, { sha, date, subject }) {
  const startIdx = html.indexOf(START)
  const endIdx = html.indexOf(END)
  if (startIdx === -1 || endIdx === -1) return html

  const section = html.slice(startIdx + START.length, endIdx)
  const tbodyOpen = section.indexOf('<tbody>')
  const tbodyClose = section.indexOf('</tbody>')
  if (tbodyOpen === -1 || tbodyClose === -1) return html

  const safe = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const newRow = `<tr><td><code>${safe(date)}</code></td><td><code>${safe(sha)}</code></td><td>${safe(subject)}</td></tr>`

  // Parse existing rows (between tbody markers).
  const existing = section.slice(tbodyOpen + '<tbody>'.length, tbodyClose).trim()
  const existingRows = existing
    ? existing.split(/(?=<tr>)/).map((r) => r.trim()).filter(Boolean)
    : []

  // Dedupe: if the latest existing row has the same SHA, replace instead of prepend.
  let rows = existingRows
  if (rows[0] && rows[0].includes(`<code>${safe(sha)}</code>`)) {
    rows = [newRow, ...rows.slice(1)]
  } else {
    rows = [newRow, ...rows]
  }
  rows = rows.slice(0, MAX_ROWS)

  const newSection = `\n<table><thead><tr><th>Date</th><th>SHA</th><th>Subject</th></tr></thead><tbody>\n${rows.join('\n')}\n</tbody></table>\n`
  return html.slice(0, startIdx + START.length) + newSection + html.slice(endIdx)
}

function main() {
  const mode = process.argv[2] || 'pre-commit'

  let files
  if (mode === 'pre-commit') {
    files = getStagedFiles()
  } else if (mode === 'post-commit') {
    files = getLastCommitFiles()
  } else {
    console.error(`unknown mode: ${mode} (use 'pre-commit' or 'post-commit')`)
    process.exit(1)
  }

  if (files.length === 0) {
    console.log('docs:stamp: no files to process')
    return
  }

  const touched = new Set()
  for (const f of files) {
    const comp = pickComponent(f)
    if (comp && comp !== '_skip') touched.add(comp)
  }

  // Always also bump component docs themselves if they're being modified
  for (const f of files) {
    const m = f.match(/^docs\/components\/([a-z0-9-]+)\.html$/)
    if (m && m[1] !== 'index') touched.add(m[1])
  }

  if (touched.size === 0) {
    console.log('docs:stamp: no component-affecting files')
    return
  }

  const meta = getCurrentCommitMeta(mode === 'pre-commit')
  const updated = []

  for (const comp of touched) {
    const htmlPath = resolve(DOCS, `${comp}.html`)
    if (!existsSync(htmlPath)) {
      console.warn(`docs:stamp: missing ${htmlPath} (skipped)`)
      continue
    }
    let html = readFileSync(htmlPath, 'utf8')
    const before = html
    html = ensureSection(html)
    html = prependRow(html, meta)
    if (html !== before) {
      writeFileSync(htmlPath, html, 'utf8')
      updated.push(`docs/components/${comp}.html`)
    }
  }

  if (updated.length === 0) {
    console.log(`docs:stamp: ${touched.size} component(s) touched but no doc changes needed`)
    return
  }

  console.log(`docs:stamp: updated ${updated.length} component doc(s):`)
  for (const u of updated) console.log(`  ${u}`)

  // Re-stage if running pre-commit.
  if (mode === 'pre-commit') {
    try {
      sh(`git add ${updated.map((u) => `"${u}"`).join(' ')}`)
      console.log('docs:stamp: re-staged')
    } catch (e) {
      console.warn(`docs:stamp: failed to re-stage: ${e.message}`)
    }
  }
}

main()
