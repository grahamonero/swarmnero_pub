// PHASE 2A SANITIZER GATE — must pass before Phase 2A ships
//
// Run as:    node ui/utils/markdown.test.js
//
// Self-contained — no test framework. Asserts that for every payload in the
// corpus, the rendered HTML contains NO active script / event handler /
// unescaped `<` that wasn't written by the sanitizer itself.
//
// Corpus:
//   1. PHASE2-DESIGN.md project-specific test gate (every payload exactly).
//   2. Cure53 markdown-it / DOMPurify pwn corpus (condensed, ~30 payloads).
//   3. Mastodon historic XSS payloads (CVE-2018-12977, CVE-2019-15795, etc.).
//   4. Bluesky / AT-Proto rich-text edge cases (HTML-entity tricks, autolinks).
//
// Failure exits non-zero so this can be wired into CI later.

import { renderArticleMarkdown } from './markdown.js'

let pass = 0
let fail = 0
const failures = []

// Allowed tags the sanitizer may emit. Anything else in tag position is a
// failure — that's the whole contract.
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 'code', 'pre',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'img', 'br'
])

// Allowed attributes per tag.
const ALLOWED_ATTRS = {
  a: new Set(['href', 'rel', 'target']),
  img: new Set(['alt', 'src'])
}

/**
 * Parse a tag's attribute string into a list of attribute names. Walks the
 * string respecting double-quoted values so attribute-name detection does
 * not reach into a quoted value.
 *
 * Input: ` alt="&quot;onerror=alert(1)&quot;" src="https://x"`
 * Output: ['alt', 'src']
 */
function parseAttrNames(s) {
  const names = []
  let i = 0
  const n = s.length
  while (i < n) {
    // skip whitespace
    while (i < n && /\s/.test(s[i])) i++
    if (i >= n) break
    // read attribute name
    let name = ''
    while (i < n && /[a-zA-Z0-9-]/.test(s[i])) {
      name += s[i]
      i++
    }
    if (!name) {
      // garbage character — advance and continue
      i++
      continue
    }
    names.push(name.toLowerCase())
    // skip whitespace + optional =
    while (i < n && /\s/.test(s[i])) i++
    if (s[i] === '=') {
      i++
      while (i < n && /\s/.test(s[i])) i++
      // value may be quoted (" or ') or bare
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i]
        i++
        while (i < n && s[i] !== q) i++
        if (s[i] === q) i++
      } else {
        while (i < n && !/\s/.test(s[i]) && s[i] !== '>') i++
      }
    }
  }
  return names
}

function assertNoActiveScript(name, input, output, extra = {}) {
  const violations = []

  // Scan for tag opens in the output. Every `<` we find must be followed by
  // either a known allowed tag (open or close) or a known allowed self-close.
  // Anything else means our sanitizer leaked.
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?>/g
  let m
  while ((m = tagRe.exec(output)) !== null) {
    const tag = m[1].toLowerCase()
    const attrPart = m[2] || ''
    if (!ALLOWED_TAGS.has(tag)) {
      violations.push(`emitted disallowed tag <${tag}>`)
      continue
    }
    // Check attribute names against the allowlist. Walk the attribute string
    // respecting quoted values so we don't see attribute names inside attribute values.
    if (attrPart) {
      const allowed = ALLOWED_ATTRS[tag] || new Set()
      const attrNames = parseAttrNames(attrPart)
      for (const an of attrNames) {
        if (!allowed.has(an)) {
          violations.push(`emitted disallowed attr "${an}" on <${tag}>`)
        }
        // Specifically: any on*= attribute is a critical fail
        if (an.startsWith('on')) violations.push(`emitted on* event handler "${an}" on <${tag}>`)
      }
    }
    // For href / src, the value must be a safe scheme.
    if (tag === 'a' && attrPart) {
      const hrefMatch = /href\s*=\s*"([^"]*)"/i.exec(attrPart)
      if (hrefMatch) {
        const href = hrefMatch[1]
        if (/^(javascript|data|vbscript|file|chrome|blob|pear):/i.test(href)) {
          violations.push(`emitted href with unsafe scheme: ${href}`)
        }
      }
    }
    if (tag === 'img' && attrPart) {
      const srcMatch = /src\s*=\s*"([^"]*)"/i.exec(attrPart)
      if (srcMatch) {
        const src = srcMatch[1]
        if (/^(javascript|data|vbscript|file|chrome|blob|http|https):/i.test(src)) {
          // images must come from swarmnero:// only
          violations.push(`emitted img src with disallowed scheme: ${src}`)
        }
      }
    }
  }

  // Reflected language class (the fenced-code info string must be stripped)
  if (extra.noLanguageClass && /class\s*=\s*["']language-/i.test(output)) {
    violations.push('reflected language- class')
  }

  // Stray `<` that wasn't part of a valid tag open/close. The output should
  // never contain a `<` that the regex above didn't consume.
  const consumed = output.replace(tagRe, '')
  if (/</.test(consumed)) {
    const stray = consumed.match(/<.{0,10}/g) || []
    violations.push(`stray < in output: ${JSON.stringify(stray.slice(0, 3))}`)
  }

  // Custom assertions
  if (extra.mustInclude) {
    for (const needle of extra.mustInclude) {
      if (!output.includes(needle)) violations.push(`missing expected fragment: ${JSON.stringify(needle)}`)
    }
  }
  if (extra.mustNotInclude) {
    for (const needle of extra.mustNotInclude) {
      if (output.includes(needle)) violations.push(`unexpected fragment present: ${JSON.stringify(needle)}`)
    }
  }

  if (violations.length === 0) {
    pass++
    return
  }
  fail++
  failures.push({ name, input, output, violations })
}

function test(name, input, extra) {
  const output = renderArticleMarkdown(input)
  assertNoActiveScript(name, input, output, extra)
}

// ============================================================================
// 1. PHASE2-DESIGN.md project-specific corpus
// ============================================================================

// Image alt-attribute breakout attempt
test(
  'design#1 image alt onerror',
  '![\"onerror=alert(1) x=\"](abc/def)',
  // The drive-ref `abc/def` is invalid (driveKey must be 64 hex), so the
  // whole construct must escape to literal text — no <img> at all.
  { mustNotInclude: ['<img'] }
)

// Image alt-attribute breakout with a VALID drive ref. The alt value must be
// fully HTML-escaped so any `"onerror=alert(1) x="` payload becomes inert text
// inside the alt="" attribute.
test(
  'design#1b image alt onerror with valid drive ref',
  '![\"onerror=alert(1) x=\"](' + 'a'.repeat(64) + '/images/foo.jpg)',
  {
    mustInclude: ['<img alt="', 'src="swarmnero://', '&quot;onerror=alert(1) x=&quot;'],
    // The literal string `" onerror=alert(1)` (with unescaped quote) must NEVER appear.
    mustNotInclude: ['" onerror=', '"onerror=alert']
  }
)

// Link with raw HTML in text — the text must be HTML-escaped
test(
  'design#2 link text with <script>',
  '[<script>alert(1)</script>](https://x.com)',
  { mustInclude: ['&lt;script&gt;', 'href="https://x.com"'], mustNotInclude: ['<script'] }
)

// javascript: URL — must escape to literal text, no <a>
test(
  'design#3 link with javascript: scheme',
  '[click](javascript:alert(1))',
  { mustNotInclude: ['<a '] }
)

// Fenced code block with html — body must be escaped, no class="language-html"
test(
  'design#4 fenced code with HTML body',
  '```html\n<script>alert(1)</script>\n```',
  { mustInclude: ['<pre><code>', '&lt;script&gt;'], noLanguageClass: true }
)

// Reference-style links — must NOT be active
test(
  'design#5 reference-style link bait',
  '[foo][bad]\n\n[bad]: javascript:alert(1)',
  { mustNotInclude: ['<a '] }
)

// Autolinks — blocked
test(
  'design#6 autolink',
  '<https://safe.com>',
  { mustNotInclude: ['<a '] }
)

// HTML entity tricks
test(
  'design#7 hex entity script',
  '&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;'
)

// ============================================================================
// 2. Cure53 markdown-it / DOMPurify pwn corpus (condensed)
// ============================================================================

const cure53Corpus = [
  // raw HTML injection attempts
  '<img src=x onerror=alert(1)>',
  '<a href=javascript:alert(1)>click</a>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)"></embed>',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<math><mtext><mglyph><svg><a href=javascript:alert(1)>X</a>',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<details open ontoggle=alert(1)>',
  // markdown that decays into raw HTML in flawed parsers
  '[a](javascript:alert(1))',
  '[a](JaVaScRiPt:alert(1))',
  '[a]( javascript:alert(1))',
  '[a](\tjavascript:alert(1))',
  '[a](java script:alert(1))',
  '[a](javascript	:alert(1))',
  '[a](javas&#99;ript:alert(1))',
  '[a](javascript&#x3a;alert(1))',
  '[a](data:text/html,<script>alert(1)</script>)',
  '[a](vbscript:msgbox(1))',
  '[a](file:///etc/passwd)',
  '![x](javascript:alert(1))',
  '![x](data:text/html,<script>alert(1)</script>)',
  '![onerror=alert(1)](x)',
  // image with title trick
  '![a](x "onerror=alert(1)")',
  // link with title trick
  '[a](https://x.com "onmouseover=alert(1)")',
  // backtick + HTML
  '`<script>alert(1)</script>`',
  // nested
  '**[<script>alert(1)</script>](https://x.com)**',
  // reference link bait with javascript
  '[a][b]\n\n[b]: javascript:alert(1)',
  // setext heading (must not become a heading)
  'Heading\n=======\n',
  // table (must escape)
  '| a | b |\n|---|---|\n| <script>alert(1)</script> | y |',
  // task list (not allowed)
  '- [x] <script>alert(1)</script>',
  // HTML entity trick
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  // mixed entity/case
  '&#X3C;img src=x onerror=alert(1)&#X3E;'
]

for (let i = 0; i < cure53Corpus.length; i++) {
  test(`cure53#${i + 1}`, cure53Corpus[i])
}

// ============================================================================
// 3. Mastodon historic XSS payloads (CVE-style — patterns from public advisories)
// ============================================================================

const mastodonCorpus = [
  // CVE-2018-12977 — onclick handler leak via specific attribute combos
  '<a onclick="alert(1)" href="https://x.com">click</a>',
  // CVE-2019-15795 — link autoescape regression
  '<a href="javascript&#x3a;alert(1)">click</a>',
  // OEmbed / shorturl style
  '<a href="https://example.com/redirect?u=javascript:alert(1)">click</a>',
  // Profile field injection
  '"><script>alert(1)</script>',
  // Status content with U+2028 line separator
  'hello <script>alert(1)</script>'
]

for (let i = 0; i < mastodonCorpus.length; i++) {
  test(`mastodon#${i + 1}`, mastodonCorpus[i])
}

// ============================================================================
// 4. Bluesky / AT-Proto rich-text edge cases
// ============================================================================

const blueskyCorpus = [
  // HTML entity that decodes to <
  '[click](https://example.com&#x3c;img+src%3dx+onerror%3dalert%281%29%3e)',
  // Autolink with javascript
  '<javascript:alert(1)>',
  // unicode-confusable scheme
  '[click](javascript:alert(1))'
]

for (let i = 0; i < blueskyCorpus.length; i++) {
  test(`bluesky#${i + 1}`, blueskyCorpus[i])
}

// ============================================================================
// Positive tests — make sure the renderer DOES emit the expected good HTML
// ============================================================================

function positiveTest(name, input, expectedFragment) {
  const output = renderArticleMarkdown(input)
  if (!output.includes(expectedFragment)) {
    fail++
    failures.push({
      name: 'positive: ' + name,
      input,
      output,
      violations: [`missing expected fragment: ${JSON.stringify(expectedFragment)}`]
    })
  } else {
    pass++
  }
}

positiveTest('h1', '# Hello', '<h1>Hello</h1>')
positiveTest('h6', '###### Hello', '<h6>Hello</h6>')
positiveTest('bold', '**bold**', '<strong>bold</strong>')
positiveTest('italic', 'a *italic* b', '<em>italic</em>')
positiveTest('strike', '~~gone~~', '<del>gone</del>')
positiveTest('inline code', 'use `foo()` here', '<code>foo()</code>')
positiveTest('link', '[swarmnero](https://swarmnero.com)', '<a href="https://swarmnero.com" rel="noopener noreferrer" target="_blank">swarmnero</a>')
positiveTest('hyper link', '[link](hyper://abcd1234)', '<a href="hyper://abcd1234"')
positiveTest('hr', '---', '<hr>')
positiveTest('ul', '- one\n- two', '<ul>')
positiveTest('ol', '1. one\n2. two', '<ol>')
positiveTest('blockquote', '> quoted', '<blockquote>')
positiveTest('fenced code', '```\nfoo\n```', '<pre><code>foo</code></pre>')
positiveTest('paragraph break', 'a\n\nb', '<p>a</p>')

// Image with valid drive ref renders
positiveTest('image valid drive ref', '![cat](' + 'a'.repeat(64) + '/images/cat.jpg)', '<img alt="cat" src="swarmnero://')

// Post-agent regression locks (Phase 2A v2 fixes)

// MEDIUM #1: nested-link emission. Inner link must NOT produce a second <a>.
test(
  'nested-link suppression',
  '[outer [inner](https://a.com) more](https://b.com)',
  { mustInclude: ['href="https://b.com"'], mustNotInclude: ['href="https://a.com"'] }
)
;(function nestedLinkSingleAnchorOnly() {
  const out = renderArticleMarkdown('[outer [inner](https://a.com) more](https://b.com)')
  const aOpens = (out.match(/<a /g) || []).length
  if (aOpens > 1) {
    fail++
    failures.push({
      name: 'nested-link single-anchor-only',
      input: '[outer [inner](https://a.com) more](https://b.com)',
      output: out,
      violations: [`expected 1 <a> open tag, got ${aOpens}`]
    })
  } else {
    pass++
  }
})()

// LOW #1: userinfo URL must be rejected (phishing display-vs-real-host trick).
test(
  'userinfo URL rejected',
  '[click](https://safe.com@evil.com/path)',
  { mustNotInclude: ['<a '] }
)

// LOW #2: balanced parens inside the URL parse as URL.
positiveTest(
  'paren-balanced URL',
  '[wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
  'href="https://en.wikipedia.org/wiki/Foo_(bar)"'
)

// ============================================================================
// Report
// ============================================================================

console.log('')
console.log('=== Phase 2A Sanitizer Test Gate ===')
console.log(`PASS: ${pass}`)
console.log(`FAIL: ${fail}`)
if (fail > 0) {
  console.log('')
  console.log('Failures:')
  for (const f of failures) {
    console.log('---')
    console.log('  test:   ', f.name)
    console.log('  input:  ', JSON.stringify(f.input))
    console.log('  output: ', f.output)
    for (const v of f.violations) console.log('  -> ', v)
  }
  process.exit(1)
}
console.log('All sanitizer payloads produced inert output.')
