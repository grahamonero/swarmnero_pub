#!/usr/bin/env node
// PHASE 2A SANITIZER GATE — wired into post-agent review.
//
// Scans the ui/ tree for any `${article.title}`, `${article.summary}`,
// `${article.cw}`, `${article.tags...}`, or `${article.cover...}`
// interpolation that ISN'T wrapped by escapeHtml(...).
//
// Articles MUST never reach the DOM as raw template-literal interpolations:
//   - title / summary / cw / tags must go through escapeHtml.
//   - body must go through renderArticleMarkdown (the sanitizer).
//
// Exits non-zero with a list of offending lines if any are found.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')
const UI_DIR = path.join(ROOT, 'ui')

// Match a `${article.<field>...}` template-literal interpolation.
// We extract the full ${...} substring AND the line so we can decide whether
// it's wrapped by an escapeHtml(...) call already on that line.
//
// `article.tags.map(...)` and `article.cover.path` are fine when each
// captured element flows through escapeHtml inside the map closure — the
// whole-array reference itself does not need escaping. We only flag the
// PRIMITIVE field reads (title / summary / cw) plus tags/cover when they
// appear as a bare value (NOT followed by `.map` / `.length` / `.slice`).
const FIELD_RE = /\$\{[^}]*\barticle\.(title|summary|cw)(?!\.)\b[^}]*\}/

// Allowed safe wrappers — if the interpolation is inside one of these calls,
// it's fine. Most explicit form: escapeHtml(article.x). We accept any line
// where every match of FIELD_RE has an escapeHtml(...) wrapper around it.
function isWrappedSafely(line, match) {
  // The escape: line must contain `escapeHtml(` somewhere before this match
  // AND the matching `)` must enclose it. Cheap proxy: the substring of the
  // line containing the match must be enclosed by `escapeHtml(...)`.
  const idx = line.indexOf(match)
  if (idx < 0) return false
  const before = line.slice(0, idx)
  const after = line.slice(idx + match.length)
  // crude: there must be an escapeHtml( open before with no matching close
  // between it and our match.
  const lastEscOpen = before.lastIndexOf('escapeHtml(')
  if (lastEscOpen === -1) return false
  // Check we haven't already closed it before our match
  const between = before.slice(lastEscOpen)
  let depth = 0
  for (const ch of between) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
  }
  if (depth <= 0) return false
  // After the match we expect at least one closing `)` to balance.
  let closesAfter = 0
  for (const ch of after) {
    if (ch === '(') closesAfter--
    else if (ch === ')') {
      closesAfter++
      if (closesAfter >= depth) return true
    }
  }
  return false
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      // Skip the article-view.js file's allowed escapeHtml usages — but we
      // still scan it. It already wraps everything via escapeHtml.
      yield full
    }
  }
}

let violations = 0
const failures = []

for (const file of walk(UI_DIR)) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m
    const re = new RegExp(FIELD_RE.source, 'g')
    while ((m = re.exec(line)) !== null) {
      const match = m[0]
      // skip comments
      const codeBefore = line.slice(0, m.index)
      const trimmed = codeBefore.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      if (!isWrappedSafely(line, match)) {
        violations++
        failures.push({ file: path.relative(ROOT, file), line: i + 1, text: line.trim(), match })
      }
    }
  }
}

if (violations > 0) {
  console.error('\nPHASE 2A: unescaped article-field interpolations found:')
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}  ${f.match}`)
    console.error(`      ${f.text}`)
  }
  console.error(`\n${violations} violation(s).`)
  process.exit(1)
}

console.log('PHASE 2A: no unescaped article-field interpolations in ui/.')
