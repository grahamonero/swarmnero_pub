/**
 * Bookmarks panel — render saved posts in the right panel.
 *
 * We never render bookmarked posts from a separate "trusted" path. Every
 * bookmarked target is looked up in the timeline (where feed.js has already
 * run verifyEventSignature during replication) AND re-verified here with an
 * explicit verifyEventSignature call before we render anything. The fact that
 * the local user bookmarked a post earlier says nothing about whether the
 * current peer copy is authentic.
 */

import { state } from '../state.js'
import { escapeHtml, safeAvatarUrl } from '../utils/dom.js'
import { formatTime, getDisplayName, renderMarkdown, getOnlineDotHtml } from '../utils/format.js'
import { verifyEventSignature } from '../../lib/feed.js'
import { getBookmarks, removeBookmark } from '../../lib/bookmarks.js'
import { isPaywalledPost } from '../../lib/events.js'
import { getUnlockedContent } from '../../lib/paywall.js'
import { showThreadInCenter } from './timeline.js'

function findPostInTimeline(pubkey, timestamp) {
  const timeline = state.currentTimeline || []
  return timeline.find(p =>
    p.type === 'post' &&
    p.pubkey === pubkey &&
    Number(p.timestamp) === Number(timestamp)
  )
}

function renderBookmarkCard(post) {
  const displayName = getDisplayName(post.pubkey, state.identity, state.myProfile, state.peerProfiles)
  const profile = post.pubkey === state.identity?.pubkeyHex ? state.myProfile : state.peerProfiles?.[post.pubkey]
  const initial = displayName.charAt(0).toUpperCase()
  const safeAv = safeAvatarUrl(profile?.avatar)
  const avatarHtml = safeAv
    ? `<div class="bookmark-avatar"><img src="${escapeHtml(safeAv)}" alt=""></div>`
    : `<div class="bookmark-avatar">${escapeHtml(initial)}</div>`

  const safePk = escapeHtml(post.pubkey)
  const safeTs = escapeHtml(String(post.timestamp))

  // Paywalled posts: show unlocked text if we have it, else a "locked" marker.
  // Never render paywall ciphertext.
  let bodyHtml
  if (isPaywalledPost(post)) {
    const unlocked = getUnlockedContent(post.pubkey, post.timestamp)
    if (unlocked) {
      bodyHtml = `<div class="bookmark-content">${renderMarkdown(unlocked.content || '')}</div>`
    } else {
      bodyHtml = `<div class="bookmark-content bookmark-locked">🔒 Paywalled — unlock to read</div>`
    }
  } else {
    bodyHtml = `<div class="bookmark-content">${renderMarkdown(post.content || '')}</div>`
  }

  return `
    <div class="bookmark-item" data-pubkey="${safePk}" data-timestamp="${safeTs}">
      <div class="bookmark-header">
        ${avatarHtml}
        <span class="bookmark-author">${escapeHtml(displayName)}</span>${getOnlineDotHtml(post.pubkey)}
        <span class="bookmark-time">${formatTime(post.timestamp)}</span>
        <button class="bookmark-remove-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="Remove bookmark">&times;</button>
      </div>
      ${bodyHtml}
    </div>
  `
}

export function renderBookmarks() {
  const container = document.getElementById('bookmarksContent')
  if (!container) return

  const entries = getBookmarks()

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="bookmarks-empty">
        <div class="empty-icon">&#128278;</div>
        <p>No bookmarks yet.</p>
        <p class="hint">Tap the bookmark icon on any post to save it here.</p>
      </div>
    `
    return
  }

  const rendered = []
  const missing = []

  for (const entry of entries) {
    const post = findPostInTimeline(entry.post_pubkey, entry.post_ts)
    if (!post) {
      missing.push(entry)
      continue
    }
    // Belt-and-braces: feed ingest verifies signatures, but re-check here so
    // a bug in ingest or a future unsigned code path cannot silently render.
    if (!verifyEventSignature(post)) {
      missing.push(entry)
      continue
    }
    rendered.push(post)
  }

  // Sort newest-bookmarked first by post timestamp (we don't track the
  // bookmark-add time separately; the post timestamp is a reasonable proxy
  // and matches timeline ordering).
  rendered.sort((a, b) => b.timestamp - a.timestamp)

  const missingHtml = missing.length > 0 ? `
    <div class="bookmarks-missing">
      <p class="hint">${missing.length} bookmarked post${missing.length === 1 ? '' : 's'} not currently available (peer offline or content unreplicated).</p>
    </div>
  ` : ''

  container.innerHTML = `
    <div class="bookmarks-list">
      ${rendered.map(renderBookmarkCard).join('')}
    </div>
    ${missingHtml}
  `

  // Click on a card (not the remove button) opens thread in center column.
  container.querySelectorAll('.bookmark-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.bookmark-remove-btn')) return
      const pubkey = item.dataset.pubkey
      const timestamp = parseInt(item.dataset.timestamp, 10)
      if (pubkey && Number.isFinite(timestamp)) {
        await showThreadInCenter(pubkey, timestamp)
      }
    })
  })

  // Remove bookmark handlers
  container.querySelectorAll('.bookmark-remove-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp, 10)
      if (!pubkey || !Number.isFinite(timestamp)) return
      btn.disabled = true
      try {
        await removeBookmark(state.feed, state.identity, pubkey, timestamp)
        renderBookmarks()
      } catch (err) {
        console.error('[Bookmarks] remove failed:', err.message)
        btn.disabled = false
      }
    })
  })
}
