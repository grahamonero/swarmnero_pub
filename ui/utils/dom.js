/**
 * DOM utility functions
 */

/**
 * Parse and validate a Swarm ID
 * Returns the lowercase swarmId or null if invalid
 * Also accepts legacy passport format for backwards compatibility
 */
export function parseSwarmId(input) {
  if (!input || typeof input !== 'string') return null

  const trimmed = input.trim()

  // Check for plain hex swarmId (64 hex chars)
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  // Legacy: also accept old passport format, extract swarmId
  const passportMatch = trimmed.match(/^swarmnero:\/\/([a-f0-9]{64})@[a-f0-9]{64}$/i)
  if (passportMatch) {
    return passportMatch[1].toLowerCase()
  }

  return null
}

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/
const MAX_AVATAR_LEN = 512 * 1024

/**
 * Validate a peer-supplied avatar URL. Only accepts base64 data URLs for
 * common raster formats (rejects javascript:, data:image/svg+xml, attribute
 * breakouts, oversized payloads). Returns the raw URL if safe, else ''.
 */
export function safeAvatarUrl(raw) {
  if (typeof raw !== 'string') return ''
  if (raw.length > MAX_AVATAR_LEN) return ''
  if (!AVATAR_DATA_URL_RE.test(raw)) return ''
  return raw
}

/**
 * Validate a peer-supplied profile website. Returns a safe http/https URL
 * string or '' if the input cannot be parsed or uses a disallowed scheme.
 */
export function safeWebsiteUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return ''
  const candidate = raw.startsWith('http://') || raw.startsWith('https://') ? raw : 'https://' + raw
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.toString()
  } catch {
    return ''
  }
}

/**
 * Insert text at cursor position in a textarea
 */
export function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = textarea.value.substring(0, start)
  const after = textarea.value.substring(end)
  textarea.value = before + text + after
  textarea.selectionStart = textarea.selectionEnd = start + text.length
  textarea.focus()
}

/**
 * Wrap selected text with before/after markers (for markdown formatting)
 */
export function wrapSelection(textarea, before, after, updateCharCount) {
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selectedText = textarea.value.substring(start, end)
  const beforeText = textarea.value.substring(0, start)
  const afterText = textarea.value.substring(end)

  if (selectedText) {
    textarea.value = beforeText + before + selectedText + after + afterText
    textarea.selectionStart = start + before.length
    textarea.selectionEnd = end + before.length
  } else {
    textarea.value = beforeText + before + after + afterText
    textarea.selectionStart = textarea.selectionEnd = start + before.length
  }
  textarea.focus()
  if (updateCharCount) updateCharCount()
}
