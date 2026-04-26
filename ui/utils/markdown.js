/**
 * Sanitizing Markdown renderer for Phase 2A long-form articles.
 *
 * CONTRACT: the sanitizer must NEVER emit a `<` it did not write itself.
 * Every captured group passes through escapeHtml BEFORE insertion.
 *
 * Deny-by-default: anything not on the allowlist below becomes literal,
 * HTML-escaped text. No silent passthrough of unknown markdown syntax.
 *
 * Allowlist:
 *  - ATX headings (# … ######) — setext blocked
 *  - **bold**, *italic*, ~~strike~~  (no _underscore_ italic — too many false positives in URLs)
 *  - > blockquote
 *  - `-` / `*` unordered list, `1.` ordered list
 *  - inline `code` and ```fenced code``` (info-string stripped, never reflected)
 *  - [text](url)  — schemes: https http hyper swarmnero
 *  - ![alt](driveRef)  where driveRef = `<64-hex>/<safe-media-path>`
 *  - --- → <hr>
 *  - blank line → paragraph break
 *
 * Blocked:
 *  - raw HTML (any `<` becomes `&lt;`)
 *  - reference-style links, autolinks, setext headings
 *  - tables, footnotes, def lists, task lists
 *  - HTML entities other than `&amp; &lt; &gt; &quot; &#39;` (decoded as literal `&` first)
 *  - link/image schemes other than the four above
 *  - external image src (image must be an internal Hyperdrive ref)
 *  - inline <style> blocks (escaped)
 *
 * See PHASE2-DESIGN.md "Markdown sanitizer — hardened spec" for the full spec.
 */

// Hard cap on input size. Mirrors lib/events.js ARTICLE_MAX_BODY.
export const MARKDOWN_MAX_LEN = 50000

// Allowed URL schemes for [text](url) links.
const ALLOWED_LINK_SCHEMES = ['https:', 'http:', 'hyper:', 'swarmnero:']

// Path prefix for image driveRef paths (mirrors isSafeMediaPath in lib/events.js).
// Articles only embed images from /images/, never video/files.
const IMAGE_PATH_PREFIX = '/images/'

// Reject characters inside URLs that could break out of href="…" or be used
// for IDN/whitespace tricks.
const URL_FORBIDDEN_CHARS_RE = /[\s<>"'`]/

/**
 * HTML-escape a string. Pure-JS so this module is testable under plain node.
 * Mirrors the semantics of ui/utils/dom.js escapeHtml (which uses textContent),
 * but without a DOM dependency.
 *
 * Escapes: & < > " ' so the output is safe both as element body AND as the
 * value of a double-quoted attribute.
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isSafeArticleImagePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false
  if (p.includes('\0') || p.includes('..')) return false
  return p.startsWith(IMAGE_PATH_PREFIX)
}

/**
 * Validate a URL for use as a link href.
 * Returns the trimmed URL if it passes, or null.
 */
function validateLinkUrl(raw) {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (url.length === 0 || url.length > 2048) return null
  // Reject any control / quote / angle-bracket / backtick / whitespace
  if (URL_FORBIDDEN_CHARS_RE.test(url)) return null
  // Block scheme-relative URLs (//evil.com)
  if (url.startsWith('//')) return null
  // Reject any HTML-entity escape inside the URL (`&#x3a;`, `&#58;`, `&colon;`)
  // — defends against scheme-obfuscation tricks like `javascript&#x3a;alert(1)`.
  if (/&#?[a-z0-9]+;/i.test(url)) return null
  // Must have an explicit allowed scheme
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!ALLOWED_LINK_SCHEMES.includes(parsed.protocol)) return null
  return url
}

/**
 * Parse a (driveRef) image argument: `<64-hex-driveKey>/<path>`.
 * Returns `{ driveKey, path }` or null on any failure.
 */
function parseImageDriveRef(raw) {
  if (typeof raw !== 'string') return null
  const ref = raw.trim()
  if (ref.length === 0 || ref.length > 1024) return null
  if (URL_FORBIDDEN_CHARS_RE.test(ref)) return null
  // Must be exactly: 64 hex chars, then `/`, then a path
  const m = /^([a-f0-9]{64})(\/.*)$/i.exec(ref)
  if (!m) return null
  const driveKey = m[1].toLowerCase()
  const path = m[2]
  if (!isSafeArticleImagePath(path)) return null
  return { driveKey, path }
}

/**
 * Build the resolved <img src="…"> URL for a driveRef.
 * For now we use a `swarmnero:` URI scheme; the renderer will resolve it
 * to a blob in a future pass. The URI itself is safe to emit as href/src
 * because nothing dereferences it without going through our resolver.
 */
function imageDriveRefToSrc(driveKey, path) {
  // swarmnero://<driveKey><path>  e.g. swarmnero://abc…/images/foo.jpg
  return `swarmnero://${driveKey}${path}`
}

// ---------------------------------------------------------------------------
// Inline-level rendering
//
// Operates on a RAW (NOT yet escaped) line of text. Captured groups (link
// text, image alt, code body, URL) are escapeHtml'd individually before being
// emitted. Any leftover characters at the end are escapeHtml'd as well, so
// the output never contains a `<` we didn't write.
// ---------------------------------------------------------------------------

/**
 * Tokenize and render inline markdown on a RAW line. Returns sanitized HTML.
 *
 * Strategy: scan left-to-right, peeling off matched constructs. Anything that
 * doesn't match a known pattern is appended as escapeHtml'd text. We never
 * pass the raw line through any HTML emit point.
 */
function renderInline(raw) {
  let out = ''
  let i = 0
  const n = raw.length

  while (i < n) {
    const ch = raw[i]

    // Inline code: `...`  (no newlines, balanced single backticks)
    if (ch === '`') {
      const close = raw.indexOf('`', i + 1)
      if (close > i && raw.slice(i + 1, close).indexOf('\n') === -1) {
        const body = raw.slice(i + 1, close)
        out += `<code>${escapeHtml(body)}</code>`
        i = close + 1
        continue
      }
      // Unmatched backtick — treat literally
      out += escapeHtml(ch)
      i++
      continue
    }

    // Image: ![alt](driveRef)
    if (ch === '!' && raw[i + 1] === '[') {
      const consumed = tryParseImage(raw, i)
      if (consumed) {
        out += consumed.html
        i = consumed.end
        continue
      }
    }

    // Link: [text](url)
    if (ch === '[') {
      const consumed = tryParseLink(raw, i)
      if (consumed) {
        out += consumed.html
        i = consumed.end
        continue
      }
    }

    // Bold: **...**
    if (ch === '*' && raw[i + 1] === '*') {
      const close = findClosingDelim(raw, i + 2, '**')
      if (close > i + 2) {
        const body = raw.slice(i + 2, close)
        out += `<strong>${renderInline(body)}</strong>`
        i = close + 2
        continue
      }
    }

    // Strikethrough: ~~...~~
    if (ch === '~' && raw[i + 1] === '~') {
      const close = findClosingDelim(raw, i + 2, '~~')
      if (close > i + 2) {
        const body = raw.slice(i + 2, close)
        out += `<del>${renderInline(body)}</del>`
        i = close + 2
        continue
      }
    }

    // Italic: *...*  (single asterisk, not preceded by * or letter to avoid foo*bar*baz mid-word)
    if (ch === '*' && raw[i + 1] !== '*') {
      const prev = i === 0 ? '' : raw[i - 1]
      if (prev !== '*') {
        const close = findClosingDelim(raw, i + 1, '*')
        if (close > i + 1 && raw[close - 1] !== '*' && raw[close + 1] !== '*') {
          const body = raw.slice(i + 1, close)
          // Body must not contain a newline or asterisk
          if (body.indexOf('\n') === -1 && body.indexOf('*') === -1 && body.length > 0) {
            out += `<em>${renderInline(body)}</em>`
            i = close + 1
            continue
          }
        }
      }
    }

    // Default: escape one character.
    out += escapeHtml(ch)
    i++
  }

  return out
}

/**
 * Find the closing position of a delimiter (e.g. `**` or `*`) starting from
 * `start`. Returns -1 if not found before a newline.
 */
function findClosingDelim(raw, start, delim) {
  for (let j = start; j <= raw.length - delim.length; j++) {
    if (raw[j] === '\n') return -1
    if (raw.slice(j, j + delim.length) === delim) return j
  }
  return -1
}

/**
 * Try to parse an image starting at position i (where raw[i] === '!').
 * Returns { html, end } or null.
 */
function tryParseImage(raw, i) {
  // raw[i] === '!', raw[i+1] === '['
  let j = i + 2
  let alt = ''
  while (j < raw.length && raw[j] !== ']' && raw[j] !== '\n') {
    alt += raw[j]
    j++
  }
  if (raw[j] !== ']' || raw[j + 1] !== '(') return null
  let k = j + 2
  let ref = ''
  while (k < raw.length && raw[k] !== ')' && raw[k] !== '\n') {
    ref += raw[k]
    k++
  }
  if (raw[k] !== ')') return null

  const dr = parseImageDriveRef(ref)
  if (!dr) return null

  const safeAlt = escapeHtml(alt)
  const src = imageDriveRefToSrc(dr.driveKey, dr.path)
  const safeSrc = escapeHtml(src)
  return {
    html: `<img alt="${safeAlt}" src="${safeSrc}">`,
    end: k + 1
  }
}

/**
 * Try to parse a link starting at position i (where raw[i] === '[').
 * Returns { html, end } or null.
 */
function tryParseLink(raw, i) {
  let j = i + 1
  let text = ''
  // Allow nested brackets in text up to one level by tracking depth
  let depth = 1
  while (j < raw.length && raw[j] !== '\n') {
    if (raw[j] === '[') depth++
    else if (raw[j] === ']') {
      depth--
      if (depth === 0) break
    }
    text += raw[j]
    j++
  }
  if (raw[j] !== ']' || raw[j + 1] !== '(') return null
  let k = j + 2
  let url = ''
  while (k < raw.length && raw[k] !== ')' && raw[k] !== '\n') {
    url += raw[k]
    k++
  }
  if (raw[k] !== ')') return null

  const safeUrl = validateLinkUrl(url)
  if (!safeUrl) return null

  const hrefAttr = escapeHtml(safeUrl)
  const innerHtml = renderInline(text)
  return {
    html: `<a href="${hrefAttr}" rel="noopener noreferrer" target="_blank">${innerHtml}</a>`,
    end: k + 1
  }
}

// ---------------------------------------------------------------------------
// Block-level parser
//
// Operates on raw (un-escaped) lines. Each block's content is funnelled through
// renderInline (which is responsible for escaping). The block parser itself
// only emits hard-coded tag opens/closes — it never interpolates user input
// into a tag.
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const BLOCKQUOTE_RE = /^>\s?(.*)$/
const HR_RE = /^---+\s*$/
const FENCE_RE = /^```([^\n]*)$/
const UL_RE = /^([-*])\s+(.+)$/
const OL_RE = /^(\d+)\.\s+(.+)$/

/**
 * Render an article markdown body to sanitized HTML.
 *
 * @param {string} body - Raw markdown source.
 * @returns {string} Sanitized HTML — safe to insert via innerHTML.
 */
export function renderArticleMarkdown(body) {
  if (typeof body !== 'string') body = String(body ?? '')
  if (body.length > MARKDOWN_MAX_LEN) body = body.slice(0, MARKDOWN_MAX_LEN)

  // Normalize line endings.
  const lines = body.replace(/\r\n?/g, '\n').split('\n')

  const out = []
  let i = 0

  // Track open block: 'ul' | 'ol' | 'blockquote' | null
  let openBlock = null
  let paragraphBuffer = []

  function flushParagraph() {
    if (paragraphBuffer.length === 0) return
    const joined = paragraphBuffer.join(' ')
    out.push(`<p>${renderInline(joined)}</p>`)
    paragraphBuffer = []
  }

  function closeBlock() {
    if (openBlock === 'ul') out.push('</ul>')
    else if (openBlock === 'ol') out.push('</ol>')
    else if (openBlock === 'blockquote') out.push('</blockquote>')
    openBlock = null
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    const fence = FENCE_RE.exec(line)
    if (fence) {
      flushParagraph()
      closeBlock()
      // Info-string is fence[1] — DELIBERATELY DISCARDED. Never reflected
      // into a class="…" attribute, per spec.
      const codeLines = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      // skip closing fence (or EOF)
      if (i < lines.length) i++
      // Body is RAW user input — escape before emitting. No language class.
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      continue
    }

    // Horizontal rule
    if (HR_RE.test(line)) {
      flushParagraph()
      closeBlock()
      out.push('<hr>')
      i++
      continue
    }

    // Heading (ATX only)
    const heading = HEADING_RE.exec(line)
    if (heading) {
      flushParagraph()
      closeBlock()
      const level = heading[1].length
      const inner = renderInline(heading[2])
      out.push(`<h${level}>${inner}</h${level}>`)
      i++
      continue
    }

    // Blockquote
    const bq = BLOCKQUOTE_RE.exec(line)
    if (bq) {
      flushParagraph()
      if (openBlock !== 'blockquote') {
        closeBlock()
        out.push('<blockquote>')
        openBlock = 'blockquote'
      }
      out.push(`<p>${renderInline(bq[1])}</p>`)
      i++
      continue
    }

    // Unordered list
    const ul = UL_RE.exec(line)
    if (ul) {
      flushParagraph()
      if (openBlock !== 'ul') {
        closeBlock()
        out.push('<ul>')
        openBlock = 'ul'
      }
      out.push(`<li>${renderInline(ul[2])}</li>`)
      i++
      continue
    }

    // Ordered list
    const ol = OL_RE.exec(line)
    if (ol) {
      flushParagraph()
      if (openBlock !== 'ol') {
        closeBlock()
        out.push('<ol>')
        openBlock = 'ol'
      }
      out.push(`<li>${renderInline(ol[2])}</li>`)
      i++
      continue
    }

    // Blank line — paragraph break
    if (/^\s*$/.test(line)) {
      flushParagraph()
      closeBlock()
      i++
      continue
    }

    // Default: accumulate into a paragraph. Close any non-paragraph block.
    if (openBlock !== null) closeBlock()
    paragraphBuffer.push(line)
    i++
  }

  flushParagraph()
  closeBlock()

  let result = out.join('\n')

  // Defense-in-depth: strip any `<style>` blocks. Our parser shouldn't produce
  // `<style>`; this is belt-and-braces.
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '')

  return result
}

// Re-exports for tests / callers that need the helpers.
export const _internal = {
  validateLinkUrl,
  parseImageDriveRef,
  isSafeArticleImagePath,
  renderInline,
  escapeHtml
}
