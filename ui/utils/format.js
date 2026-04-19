/**
 * Formatting utility functions
 */

import { escapeHtml } from './dom.js'
import { state } from '../state.js'

/**
 * Format timestamp as relative time
 */
export function formatTime(ts) {
  const date = new Date(ts)
  const now = new Date()
  const diff = now - date

  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return date.toLocaleDateString()
}

/**
 * Get display name for a pubkey
 */
export function getDisplayName(pubkey, identity, myProfile, peerProfiles) {
  if (pubkey === identity?.pubkeyHex && myProfile?.name) {
    return myProfile.name
  }
  if (peerProfiles?.[pubkey]?.name) {
    return peerProfiles[pubkey].name
  }
  // Friendly fallback for users without a synced profile
  if (pubkey) {
    return `User ${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`
  }
  return 'Unknown'
}

const MAX_MARKDOWN_LEN = 32 * 1024

function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Render simple markdown to HTML
 */
export function renderMarkdown(text) {
  if (typeof text !== 'string') text = String(text ?? '')
  if (text.length > MAX_MARKDOWN_LEN) text = text.slice(0, MAX_MARKDOWN_LEN)
  let html = escapeHtml(text)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
    if (!isSafeHttpUrl(url)) return linkText
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${linkText}</a>`
  })
  // Auto-link bare URLs, but skip URLs already inside href attributes
  html = html.replace(/(https?:\/\/[^\s<"]+)/g, (match, url, offset, string) => {
    // Check if this URL is inside an href attribute
    const before = string.slice(Math.max(0, offset - 200), offset)
    if (before.match(/href=["'][^"']*$/)) return match
    if (!isSafeHttpUrl(url)) return match
    const safe = escapeHtml(url)
    return `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`
  })
  return html
}

/**
 * Determine online status for an author by pubkey.
 * Returns:
 *   'online'  — pubkey maps to a swarmId that is currently active on the Discovery topic
 *   'offline' — pubkey maps to a swarmId we know about, but it's not active right now
 *   'unknown' — we have no swarmId mapping for this pubkey (don't render a dot)
 *
 * Self (own pubkey) returns 'unknown' so we don't show a dot on our own posts.
 */
export function isAuthorOnline(pubkey) {
  if (!pubkey) return 'unknown'
  if (pubkey === state.identity?.pubkeyHex) return 'unknown'

  const swarmId = state.pubkeyToSwarmId?.[pubkey]
  if (!swarmId) return 'unknown'

  if (state.onlineSwarmIds?.has(swarmId)) return 'online'
  return 'offline'
}

/**
 * Render the online/offline dot HTML for an author. Returns empty string for unknown status.
 * @param {string} pubkey - Author's pubkey
 * @returns {string} HTML for the dot, or empty string
 */
export function getOnlineDotHtml(pubkey) {
  const status = isAuthorOnline(pubkey)
  if (status === 'unknown') return ''
  const title = status === 'online' ? 'Online now' : 'Offline'
  return `<span class="online-dot online-dot-${status}" title="${title}"></span>`
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
