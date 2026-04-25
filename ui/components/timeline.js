/**
 * Timeline component - post rendering and display
 */

import { state, dom } from '../state.js'
import { escapeHtml, wrapSelection, insertAtCursor, safeAvatarUrl, safeWebsiteUrl } from '../utils/dom.js'
import { initEmojiPicker } from '../utils/emoji.js'
import { formatTime, getDisplayName, renderMarkdown, formatFileSize, getOnlineDotHtml } from '../utils/format.js'
import {
  createDeleteEvent,
  createLikeEvent,
  createRepostEvent,
  createReplyEvent,
  createReplyMetadataEvent,
  createPollVoteEvent,
  getInteractionCounts,
  hasLiked,
  hasReposted,
  getReplies,
  getAllRepliesFlat,
  tallyPollVotes,
  validatePollEvent
} from '../../lib/events.js'
import { showTipModal } from './tip.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'
import { showFollowingModal, showFollowersModal, getFollowingForPubkey, getFollowersCount } from './panel.js'
import { isPaywalledPost } from '../../lib/events.js'
import { getUnlockedContent, isPostUnlocked } from '../../lib/paywall.js'
import { showPaywallUnlockModal } from './paywall-modal.js'
import { isBookmarked, addBookmark, removeBookmark } from '../../lib/bookmarks.js'
import { isAuthorOnline } from '../utils/format.js'
import { schedulePublicSiteRebuild } from '../../app.js'
import { MAX_PEER_FILE_BYTES } from '../../lib/media.js'

// Even for direct follows, don't auto-pull files larger than this — require
// an explicit "click to load" to protect followers on metered connections.
const AUTO_LOAD_THRESHOLD_BYTES = 25 * 1024 * 1024 // 25 MB

// Is this post/reply/repost author someone the viewer directly follows?
// Used to skip the peer-file size cap for trusted sources (direct follows)
// while keeping the 25 MB cap in place for FoF content.
function isAuthorFollowed(authorPubkey) {
  if (!authorPubkey || !state.feed || !state.identity) return false
  if (authorPubkey === state.identity.pubkeyHex) return true
  const swarmId = state.pubkeyToSwarmId?.[authorPubkey]
  if (!swarmId) return false
  return state.feed.peers?.has?.(swarmId) || false
}

// Render one media item into a container.
//   - Direct follows: auto-load up to 100 MB, show "click to load" badge above
//   - FoF / untrusted:   auto-load up to 25 MB, show badge above
// The badge is the same in both cases: `📎 Large file (X MB) — click to load`.
async function renderMediaInto(container, authorPubkey, m) {
  const trusted = isAuthorFollowed(authorPubkey)
  const autoThreshold = trusted ? AUTO_LOAD_THRESHOLD_BYTES : MAX_PEER_FILE_BYTES
  // Our own uploads: no need to probe a "peer" drive for size — we have the
  // bytes locally. getPeerEntryInfo would hang here because it opens a
  // read-only view of our own drive and waits on peerDrive.update() which
  // never fires for a drive we own.
  const isOwnMedia = state.media && m.driveKey === state.media.driveKey

  try {
    if (!isOwnMedia) {
      // Cheap metadata probe first — avoids downloading a huge file only to
      // realize we should have gated it behind a badge.
      const info = await state.media.getPeerEntryInfo(m.driveKey, m.path).catch(() => null)

      if (info && info.size > autoThreshold) {
        renderLargeMediaBadge(container, m, info.size)
        return
      }
    }

    const url = await state.media.getImageUrl(m.driveKey, m.path, { noSizeCap: trusted })
    if (url) {
      appendMediaElement(container, m, url)
      return
    }

    // Fallback: size unknown (probe failed) and fetch returned null. If the
    // author isn't trusted, the cap may have blocked it — show the badge so
    // the user can retry with consent.
    if (!trusted) {
      const info2 = await state.media.getPeerEntryInfo(m.driveKey, m.path).catch(() => null)
      if (info2 && info2.size > MAX_PEER_FILE_BYTES) {
        renderLargeMediaBadge(container, m, info2.size)
      }
    }
  } catch (err) {
    console.error('Error loading media:', err)
  }
}

function renderLargeMediaBadge(container, m, size) {
  // If the uploader generated a thumbnail at upload time, show it as a preview
  // frame so the follower can see what they're choosing to download.
  const wrapper = document.createElement('div')
  wrapper.className = 'large-media-preview'

  if (m.thumb && typeof m.thumb === 'string' && m.thumb.startsWith('data:image/')) {
    const thumbImg = document.createElement('img')
    thumbImg.src = m.thumb
    thumbImg.className = 'large-media-thumb'
    thumbImg.alt = 'preview'
    wrapper.appendChild(thumbImg)
    if (m.type === 'video' || m.mimeType?.startsWith('video/')) {
      const playOverlay = document.createElement('span')
      playOverlay.className = 'large-media-play-overlay'
      playOverlay.textContent = '▶'
      wrapper.appendChild(playOverlay)
    }
  }

  const btn = document.createElement('button')
  btn.className = 'large-media-badge'
  btn.textContent = `📎 Large file (${formatFileSize(size)}) — click to load`
  btn.addEventListener('click', async () => {
    btn.disabled = true
    btn.textContent = 'Loading…'
    try {
      const url = await state.media.getImageUrl(m.driveKey, m.path, { noSizeCap: true })
      if (url) {
        wrapper.remove()
        appendMediaElement(container, m, url)
      } else {
        btn.textContent = 'Failed to load'
        btn.disabled = false
      }
    } catch (err) {
      btn.textContent = 'Failed to load'
      btn.disabled = false
    }
  })
  wrapper.appendChild(btn)
  container.appendChild(wrapper)
}

function appendMediaElement(container, m, url) {
  if (m.type === 'video' || m.mimeType?.startsWith('video/')) {
    const video = document.createElement('video')
    video.src = url
    video.className = 'post-video'
    video.controls = true
    video.preload = 'metadata'
    container.appendChild(video)
  } else if (m.mimeType?.startsWith('image/')) {
    const img = document.createElement('img')
    img.src = url
    img.className = 'post-image'
    img.alt = 'attached image'
    container.appendChild(img)
  } else if (m.type === 'file') {
    const fileDiv = document.createElement('div')
    fileDiv.className = 'post-file'
    fileDiv.innerHTML = `
      <span class="file-icon">&#128206;</span>
      <a href="${url}" download="${escapeHtml(m.filename || 'file')}" class="file-link">${escapeHtml(m.filename || 'Download file')}</a>
      <span class="file-size">(${formatFileSize(m.size)})</span>
    `
    container.appendChild(fileDiv)
  } else {
    const img = document.createElement('img')
    img.src = url
    img.className = 'post-image'
    img.alt = 'attached image'
    container.appendChild(img)
  }
}

// Render a list of media descriptors. Images group into a carousel; videos and
// files render inline individually (they don't lightbox the same way).
//   1 image  -> full-width inline
//   2-3      -> equal-width grid row
//   4+       -> first 3 tiles + "+N more" overflow tile
// Any image tile click opens a swipeable lightbox across the full image set.
async function renderMediaCollection(container, authorPubkey, mediaList) {
  if (!Array.isArray(mediaList) || mediaList.length === 0) return

  const images = []
  const rest = []
  for (const m of mediaList) {
    const isImage = (m?.mimeType && m.mimeType.startsWith('image/')) && m.type !== 'video'
    if (isImage) images.push(m)
    else rest.push(m)
  }

  if (images.length === 0) {
    for (const m of rest) await renderMediaInto(container, authorPubkey, m)
    return
  }

  if (images.length === 1 && rest.length === 0) {
    await renderMediaInto(container, authorPubkey, images[0])
    return
  }

  const visibleCount = Math.min(images.length, 3)
  const overflow = images.length - visibleCount

  const grid = document.createElement('div')
  grid.className = `carousel-grid carousel-grid-${visibleCount}`
  container.appendChild(grid)

  for (let i = 0; i < visibleCount; i++) {
    const tile = document.createElement('button')
    tile.type = 'button'
    tile.className = 'carousel-tile'
    tile.setAttribute('aria-label', `Image ${i + 1} of ${images.length}`)
    await renderCarouselTile(tile, authorPubkey, images[i])
    if (i === visibleCount - 1 && overflow > 0) {
      const badge = document.createElement('span')
      badge.className = 'carousel-overflow-badge'
      badge.textContent = `+${overflow}`
      tile.appendChild(badge)
    }
    tile.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openLightbox(authorPubkey, images, i)
    })
    grid.appendChild(tile)
  }

  for (const m of rest) await renderMediaInto(container, authorPubkey, m)
}

// Populate a tile with either the inline thumb (if the author shipped one) or
// the on-drive image. Thumbnail decode is wrapped in try/catch; on any failure
// we drop a placeholder icon in so render never crashes the post.
async function renderCarouselTile(tile, authorPubkey, m) {
  try {
    if (m.thumb && typeof m.thumb === 'string' && m.thumb.startsWith('data:image/')) {
      const img = document.createElement('img')
      img.src = m.thumb
      img.alt = 'attachment'
      img.className = 'carousel-thumb'
      img.onerror = () => replaceWithPlaceholder(tile)
      tile.appendChild(img)
      return
    }
  } catch (err) {
    console.warn('[Carousel] thumb render failed, falling back to full fetch:', err?.message)
  }

  try {
    const trusted = isAuthorFollowed(authorPubkey)
    const url = await state.media.getImageUrl(m.driveKey, m.path, { noSizeCap: trusted })
    if (!url) {
      replaceWithPlaceholder(tile)
      return
    }
    const img = document.createElement('img')
    img.src = url
    img.alt = 'attachment'
    img.className = 'carousel-thumb'
    img.onerror = () => replaceWithPlaceholder(tile)
    tile.appendChild(img)
  } catch (err) {
    console.warn('[Carousel] full fetch failed, rendering placeholder:', err?.message)
    replaceWithPlaceholder(tile)
  }
}

function replaceWithPlaceholder(tile) {
  tile.innerHTML = ''
  const ph = document.createElement('span')
  ph.className = 'carousel-placeholder'
  ph.textContent = '\u{1F5BC}'
  tile.appendChild(ph)
}

// Simple swipeable lightbox. Dismiss on overlay click / Esc. Left-right arrow
// keys and on-screen prev/next for navigation. Pointer drag also swipes.
function openLightbox(authorPubkey, images, startIndex) {
  document.querySelector('.carousel-lightbox')?.remove()

  const overlay = document.createElement('div')
  overlay.className = 'carousel-lightbox'

  const stage = document.createElement('div')
  stage.className = 'carousel-lightbox-stage'
  const imgEl = document.createElement('img')
  imgEl.className = 'carousel-lightbox-image'
  imgEl.alt = ''
  stage.appendChild(imgEl)

  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'carousel-lightbox-nav carousel-lightbox-prev'
  prev.textContent = '\u2039'
  prev.setAttribute('aria-label', 'Previous image')

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'carousel-lightbox-nav carousel-lightbox-next'
  next.textContent = '\u203A'
  next.setAttribute('aria-label', 'Next image')

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'carousel-lightbox-close'
  close.textContent = '\u00D7'
  close.setAttribute('aria-label', 'Close')

  const counter = document.createElement('div')
  counter.className = 'carousel-lightbox-counter'

  overlay.appendChild(stage)
  overlay.appendChild(prev)
  overlay.appendChild(next)
  overlay.appendChild(close)
  overlay.appendChild(counter)
  document.body.appendChild(overlay)

  let idx = Math.max(0, Math.min(startIndex, images.length - 1))
  let currentUrl = null

  async function showAt(i) {
    idx = (i + images.length) % images.length
    counter.textContent = `${idx + 1} / ${images.length}`
    prev.disabled = images.length < 2
    next.disabled = images.length < 2

    if (currentUrl) {
      try { URL.revokeObjectURL(currentUrl) } catch {}
      currentUrl = null
    }

    const m = images[idx]
    imgEl.src = ''
    try {
      const trusted = isAuthorFollowed(authorPubkey)
      const url = await state.media.getImageUrl(m.driveKey, m.path, { noSizeCap: trusted })
      if (url) {
        currentUrl = url
        imgEl.src = url
      } else if (m.thumb && m.thumb.startsWith('data:image/')) {
        imgEl.src = m.thumb
      } else {
        imgEl.alt = 'Image failed to load'
      }
    } catch (err) {
      console.warn('[Carousel] lightbox load failed:', err?.message)
      if (m.thumb && m.thumb.startsWith('data:image/')) imgEl.src = m.thumb
    }
  }

  function dismiss() {
    if (currentUrl) {
      try { URL.revokeObjectURL(currentUrl) } catch {}
    }
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }

  function onKey(e) {
    if (e.key === 'Escape') dismiss()
    else if (e.key === 'ArrowLeft') showAt(idx - 1)
    else if (e.key === 'ArrowRight') showAt(idx + 1)
  }

  prev.addEventListener('click', (e) => { e.stopPropagation(); showAt(idx - 1) })
  next.addEventListener('click', (e) => { e.stopPropagation(); showAt(idx + 1) })
  close.addEventListener('click', (e) => { e.stopPropagation(); dismiss() })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss() })
  stage.addEventListener('click', (e) => e.stopPropagation())
  document.addEventListener('keydown', onKey)

  // Pointer swipe
  let pointerStartX = null
  stage.addEventListener('pointerdown', (e) => { pointerStartX = e.clientX })
  stage.addEventListener('pointerup', (e) => {
    if (pointerStartX == null) return
    const dx = e.clientX - pointerStartX
    pointerStartX = null
    if (Math.abs(dx) > 40) {
      if (dx < 0) showAt(idx + 1)
      else showAt(idx - 1)
    }
  })

  showAt(idx)
}

// Callback for author clicks (set by app.js)
let onAuthorClickCallback = null
// Callback for thread clicks (set by app.js)
let onThreadClickCallback = null
// Callback for refreshing UI
let refreshUICallback = null
// Track pending media/files per inline reply form (keyed by form element)
const inlineReplyMedia = new WeakMap() // form -> { media: File[], files: File[] }

// Default UI collapse depth for nested replies. Anything past this depth is
// hidden behind a "+N more replies" stub until the user explicitly expands
// that thread. The parser (lib/events.js) enforces a separate hard cap of
// MAX_REPLY_DEPTH for DoS protection — this is purely a render-layer default.
const UI_REPLY_COLLAPSE_DEPTH = 3

// Per-post expansion state: "<pubkey>:<timestamp>" of post roots whose deep
// replies the user has chosen to reveal. Cleared by resetTimelinePagination
// on account switch / major view change.
const expandedReplyThreads = new Set()

// Flag to prevent renderPosts from overwriting center column profile/thread views
let centerViewActive = false

/**
 * Show a toast notification in the upper right corner
 */
export function showToast(title, message, type = 'success') {
  // Ensure toast container exists
  let container = document.querySelector('.toast-container')
  if (!container) {
    container = document.createElement('div')
    container.className = 'toast-container'
    document.body.appendChild(container)
  }

  // Create toast element
  const toast = document.createElement('div')
  toast.className = `toast ${type}`
  toast.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    <div class="toast-message">${escapeHtml(message)}</div>
  `

  container.appendChild(toast)

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.classList.add('hiding')
    setTimeout(() => toast.remove(), 300)
  }, 4000)
}

/**
 * Set the callback for when an author name is clicked
 */
export function setOnAuthorClick(callback) {
  onAuthorClickCallback = callback
}

/**
 * Set the callback for when a post is clicked to open thread view
 */
export function setOnThreadClick(callback) {
  onThreadClickCallback = callback
}

/**
 * Schedule a debounced refresh to prevent flicker from rapid events
 */
export function scheduleRefresh(refreshUI) {
  if (state.refreshDebounce) clearTimeout(state.refreshDebounce)
  state.refreshDebounce = setTimeout(() => {
    refreshUI()
  }, 100) // Wait 100ms for events to settle
}

/**
 * Reset timeline pagination to initial state
 * Call this when switching views or after major timeline changes
 */
export function resetTimelinePagination() {
  state.timelineVisibleCount = state.timelinePageSize
  expandedReplyThreads.clear()
}

/**
 * Update the post count display
 */
export function updatePostCount(timeline) {
  const allPosts = timeline.filter(e => e.type === 'post')
  const deletedKeys = new Set(
    timeline.filter(p => p.type === 'delete' && p.pubkey).map(p => `${p.pubkey}:${p.post_timestamp}`)
  )
  const visiblePosts = allPosts.filter(p => !deletedKeys.has(`${p.pubkey}:${p.timestamp}`))

  if (dom.postCountDisplay) {
    dom.postCountDisplay.textContent = `${visiblePosts.length} of ${allPosts.length} posts`
  }
}

/**
 * Render posts to the timeline
 */
export async function renderPosts(posts, refreshUI) {
  // Don't overwrite center column when showing a profile or thread view
  if (centerViewActive) {
    // Still update timeline data for when we return
    state.currentTimeline = posts
    updatePostCount(posts)
    return
  }

  // Store timeline in state for interactions
  state.currentTimeline = posts

  // Update post count
  updatePostCount(posts)

  if (!posts || posts.length === 0) {
    dom.postsEl.innerHTML = '<div class="empty"><div class="empty-icon">&#128172;</div>No posts yet. Write something or follow someone!</div>'
    return
  }

  // Get deleted {pubkey}:{timestamp} keys to filter them out (per-author)
  const deletedKeys = new Set(
    posts.filter(p => p.type === 'delete' && p.pubkey).map(p => `${p.pubkey}:${p.post_timestamp}`)
  )

  const myPubkey = state.identity?.pubkeyHex
  const filterMyOnly = !!(state.showMyPostsOnly && myPubkey)

  // Get all posts (not deleted)
  let postEvents = posts.filter(p =>
    p.type === 'post' && !deletedKeys.has(`${p.pubkey}:${p.timestamp}`)
  )

  // Get all reposts (exclude deleted ones)
  let repostEvents = posts.filter(p =>
    p.type === 'repost' && !deletedKeys.has(`${p.pubkey}:${p.timestamp}`)
  )

  // Get all poll events (exclude deleted ones, validate structure)
  let pollEvents = posts.filter(p =>
    p.type === 'poll' &&
    !deletedKeys.has(`${p.pubkey}:${p.timestamp}`) &&
    validatePollEvent(p)
  )

  if (filterMyOnly) {
    postEvents = postEvents.filter(p => p.pubkey === myPubkey)
    repostEvents = repostEvents.filter(p => p.pubkey === myPubkey)
    pollEvents = pollEvents.filter(p => p.pubkey === myPubkey)
  }

  // Build timeline items: original posts + reposts + polls (sorted by time)
  const timelineItems = []

  // Add original posts
  for (const post of postEvents) {
    timelineItems.push({ type: 'post', post, timestamp: post.timestamp })
  }

  // Add polls
  for (const poll of pollEvents) {
    timelineItems.push({ type: 'poll', poll, timestamp: poll.timestamp })
  }

  // Add reposts (find original post and wrap it)
  for (const repost of repostEvents) {
    // When filtering to my posts, originalPost lookup must include posts from
    // anyone (reposts are of others' posts). Use full posts array.
    const originalPost = posts.find(p =>
      p.type === 'post' &&
      p.pubkey === repost.to_pubkey &&
      p.timestamp === repost.post_timestamp &&
      !deletedKeys.has(`${p.pubkey}:${p.timestamp}`)
    )
    if (originalPost) {
      timelineItems.push({
        type: 'repost',
        post: originalPost,
        repostedBy: repost.pubkey,
        comment: repost.comment,
        timestamp: repost.timestamp
      })
    }
  }

  // In "My posts" mode, surface my replies as top-level items so replies to
  // other users' posts are visible.
  if (filterMyOnly) {
    const myReplies = posts.filter(e =>
      e.type === 'reply' &&
      e.pubkey === myPubkey &&
      !deletedKeys.has(`${e.pubkey}:${e.timestamp}`)
    )
    for (const reply of myReplies) {
      timelineItems.push({ type: 'myreply', reply, timestamp: reply.timestamp })
    }
  }

  // Sort by timestamp, newest first
  timelineItems.sort((a, b) => b.timestamp - a.timestamp)

  if (timelineItems.length === 0) {
    const emptyMsg = filterMyOnly
      ? "You haven't posted or replied yet."
      : 'No posts yet. Write something or follow someone!'
    dom.postsEl.innerHTML = `<div class="empty"><div class="empty-icon">&#128172;</div>${emptyMsg}</div>`
    return
  }

  // Pagination: limit items to currently visible count
  const totalItems = timelineItems.length
  const visibleItems = timelineItems.slice(0, state.timelineVisibleCount)
  const hasMoreItems = totalItems > state.timelineVisibleCount

  // Helper to get avatar HTML for a user
  function getAvatarHtml(pubkey, size = 'post') {
    const isMe = pubkey === myPubkey
    const profile = isMe ? state.myProfile : state.peerProfiles[pubkey]
    const displayName = getDisplayName(pubkey, state.identity, state.myProfile, state.peerProfiles)
    const initial = displayName.charAt(0).toUpperCase()
    const cssClass = size === 'reply' ? 'reply-avatar' : 'post-avatar'

    const safeAvatar = safeAvatarUrl(profile?.avatar)
    if (safeAvatar) {
      return `<div class="${cssClass}"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
    }
    return `<div class="${cssClass}">${escapeHtml(initial)}</div>`
  }

  // Helper to render a single post with replies
  function renderPostWithReplies(post, idx, repostInfo = null) {
    const hasMedia = post.media && post.media.length > 0
    const isOwnPost = post.pubkey === myPubkey
    const displayName = getDisplayName(post.pubkey, state.identity, state.myProfile, state.peerProfiles)
    const safePk = escapeHtml(post.pubkey || '')
    const safeTs = escapeHtml(String(post.timestamp || ''))

    // Get interaction counts
    const counts = getInteractionCounts(posts, post.pubkey, post.timestamp)
    const liked = hasLiked(posts, myPubkey, post.pubkey, post.timestamp)
    const reposted = hasReposted(posts, myPubkey, post.pubkey, post.timestamp)

    // Get all replies in thread (including nested replies to replies).
    // The parser caps recursion at MAX_REPLY_DEPTH for DoS protection; here we
    // apply a softer UI-layer collapse that hides replies deeper than
    // UI_REPLY_COLLAPSE_DEPTH behind a "+N more replies" stub.
    const allRepliesInThread = getAllRepliesFlat(posts, post.pubkey, post.timestamp)
    const threadKey = `${post.pubkey}:${post.timestamp}`
    const isExpanded = expandedReplyThreads.has(threadKey)
    const replies = isExpanded
      ? allRepliesInThread
      : allRepliesInThread.filter(r => r._depth < UI_REPLY_COLLAPSE_DEPTH)
    const hiddenByDepth = allRepliesInThread.length - replies.length

    // Find hidden replies - people who replied according to OP's reply_metadata but we don't follow
    const replyMetadata = posts.filter(e =>
      e.type === 'reply_metadata' &&
      e.pubkey === post.pubkey && // Metadata from the post author (OP)
      e.post_timestamp === post.timestamp
    )

    // Filter to repliers we don't follow and haven't already seen. Use the
    // full thread (including depth-collapsed) so a replier who is rendered
    // behind the "+N more" stub still counts as "already known".
    const visibleReplierPubkeys = new Set(allRepliesInThread.map(r => r.pubkey))
    const hiddenRepliers = replyMetadata
      .map(m => m.replier)
      .filter(r => {
        // Hidden if: we don't follow them AND we don't already see their reply
        const swarmId = r.swarm_id
        const isFollowing = swarmId && state.feed?.peers?.has(swarmId)
        const alreadyVisible = visibleReplierPubkeys.has(r.pubkey)
        return !isFollowing && !alreadyVisible
      })
      // Deduplicate by pubkey
      .filter((r, i, arr) => arr.findIndex(x => x.pubkey === r.pubkey) === i)

    // Build hidden replies indicator HTML
    const hiddenRepliesHtml = hiddenRepliers.length > 0 ? `
      <div class="hidden-replies-indicator">
        <span class="hidden-count">${hiddenRepliers.length} hidden ${hiddenRepliers.length === 1 ? 'reply' : 'replies'}</span>
        <div class="hidden-repliers">
          ${hiddenRepliers.map(r => {
            // Check if this swarmId is currently being followed
            const isPending = state.pendingFollows.has(r.swarm_id)
            return `
            <div class="hidden-replier"${isPending ? ' style="opacity: 0.5"' : ''}>
              <span class="hidden-replier-name">@${escapeHtml(r.name || r.pubkey.slice(0, 8) + '...')}</span>
              <button class="follow-hidden-btn${isPending ? ' processing' : ''}" data-swarm-id="${escapeHtml(r.swarm_id || '')}" data-name="${escapeHtml(r.name || '')}"${isPending ? ' disabled' : ''}>${isPending ? 'Following, please wait...' : 'Follow'}</button>
            </div>
          `}).join('')}
        </div>
      </div>
    ` : ''

    // Repost header
    const repostHeader = repostInfo ? `
      <div class="repost-header">
        <span class="repost-icon">\u21BB</span>
        <span class="repost-by">${escapeHtml(getDisplayName(repostInfo.repostedBy, state.identity, state.myProfile, state.peerProfiles))} reposted</span>
      </div>
      ${repostInfo.comment ? `<div class="repost-comment">${renderMarkdown(repostInfo.comment)}</div>` : ''}
    ` : ''

    // Render replies inline. Render the wrapper if we have any visible
    // replies OR a collapsed-deep stub to display.
    const repliesHtml = (replies.length > 0 || hiddenByDepth > 0) ? `
      <div class="post-replies">
        ${replies.map(reply => {
          const replyAuthor = getDisplayName(reply.pubkey, state.identity, state.myProfile, state.peerProfiles)
          const isOwnReply = reply.pubkey === myPubkey
          const hasReplyMedia = reply.media && reply.media.length > 0
          const replyCounts = getInteractionCounts(posts, reply.pubkey, reply.timestamp)
          const replyReposted = hasReposted(posts, myPubkey, reply.pubkey, reply.timestamp)
          const replyLiked = hasLiked(posts, myPubkey, reply.pubkey, reply.timestamp)
          const replySupporterManager = getSupporterManager()
          const replyIsSupporter = replySupporterManager?.isListed(reply.pubkey)
          const replySupporterBadge = replyIsSupporter ? '<span class="supporter-badge" title="Supporter"><span class="badge-icon">★</span>Supporter</span>' : ''
          // Show "replying to @X" for nested replies (replies to replies)
          const isNestedReply = reply._depth > 0
          const parentName = isNestedReply ? getDisplayName(reply._parentPubkey, state.identity, state.myProfile, state.peerProfiles) : ''
          const replyingToHtml = isNestedReply ? `<span class="replying-to">replying to @${escapeHtml(parentName)}</span>` : ''
          // Calculate indent based on depth (16px per level)
          const indentStyle = reply._depth > 0 ? ` style="margin-left: ${reply._depth * 16}px"` : ''
          const safePubkey = escapeHtml(reply.pubkey || '')
          const safeTs = escapeHtml(String(reply.timestamp || ''))
          return `
            <div class="reply${isNestedReply ? ' nested-reply' : ''}" data-pubkey="${safePubkey}" data-timestamp="${safeTs}"${indentStyle}>
              <div class="reply-header">
                ${getAvatarHtml(reply.pubkey, 'reply')}
                <span class="reply-author" data-pubkey="${safePubkey}">${escapeHtml(replyAuthor)}</span>${getOnlineDotHtml(reply.pubkey)}${replySupporterBadge}
                ${replyingToHtml}
                <span class="reply-time">${formatTime(reply.timestamp)}</span>
              </div>
              <div class="reply-content">${renderMarkdown(reply.content || '')}</div>
              ${hasReplyMedia ? `<div class="reply-media" data-media-pubkey="${safePubkey}" data-media-ts="${safeTs}"></div>` : ''}
              <div class="reply-actions">
                ${!isOwnReply ? `<button class="action-btn like-btn reply-like-btn ${replyLiked ? 'liked' : ''}" data-pubkey="${safePubkey}" data-timestamp="${safeTs}" title="Like">
                  <span class="action-icon">${replyLiked ? '\u2764' : '\u2661'}</span>
                  <span class="action-count">${replyCounts.likes || ''}</span>
                </button>` : ''}
                <button class="action-btn reply-repost-btn ${replyReposted ? 'reposted' : ''}" data-pubkey="${safePubkey}" data-timestamp="${safeTs}" title="Repost">
                  <span class="action-icon">\u21BB</span>
                  <span class="action-count">${replyCounts.reposts || ''}</span>
                </button>
                <button class="action-btn reply-reply-btn" data-pubkey="${safePubkey}" data-timestamp="${safeTs}" title="Reply">
                  <span class="action-icon">\u{1F4AC}</span>
                  <span class="action-count">${replyCounts.replies || ''}</span>
                </button>
                <button class="action-btn reply-tip-btn" data-pubkey="${safePubkey}" data-timestamp="${safeTs}" data-is-own="${isOwnReply}" title="Send tip">
                  <svg class="action-icon monero-icon" viewBox="0 0 496 512" width="16" height="16"><path fill="currentColor" d="M352 384h108.4C417 455.9 338.1 504 248 504S79 455.9 35.6 384H144V256.2L248 361l104-105v128zM88 336V128l159.4 159.4L408 128v208h74.8c8.5-25.1 13.2-52 13.2-80C496 119 385 8 248 8S0 119 0 256c0 28 4.6 54.9 13.2 80H88z"/></svg>
                </button>
                ${isOwnReply ? `<button class="action-btn delete-btn reply-delete-btn" data-timestamp="${safeTs}" data-is-reply="true" title="Delete reply">&#128465;</button>` : ''}
              </div>
              <div class="inline-repost-form hidden" data-pubkey="${safePubkey}" data-timestamp="${safeTs}">
                <textarea class="inline-repost-input" placeholder="Add a comment (optional)..." rows="2"></textarea>
                <div class="inline-repost-actions">
                  <button class="cancel-repost-btn">Cancel</button>
                  <button class="send-repost-btn">Repost</button>
                </div>
              </div>
            </div>
          `
        }).join('')}
        ${hiddenByDepth > 0 ? `
          <div class="replies-collapsed-stub">
            <button class="replies-expand-btn" type="button">
              +${hiddenByDepth} more ${hiddenByDepth === 1 ? 'reply' : 'replies'}
            </button>
          </div>
        ` : ''}
      </div>
    ` : ''

    const supporterManager = getSupporterManager()
    const isSupporter = supporterManager?.isListed(post.pubkey)
    const supporterBadge = isSupporter ? '<span class="supporter-badge" title="Supporter"><span class="badge-icon">★</span>Supporter</span>' : ''

    // Content warning (shown above post body, blurs content until revealed).
    // Strictly optional; only a non-empty, trimmed string under the cap is
    // rendered. escapeHtml is mandatory — the label comes from peer input.
    const rawCw = (typeof post.cw === 'string') ? post.cw.trim() : ''
    const cwLabel = (rawCw && rawCw.length <= 200) ? rawCw : ''

    // Paywall rendering: locked vs unlocked
    const paywalled = isPaywalledPost(post)
    let postBodyHtml = ''
    let postHasMedia = hasMedia
    if (paywalled) {
      // The author cached their own content at creation time, so getUnlockedContent
      // returns it for them. Buyers who have unlocked also see content via the same map.
      const unlocked = getUnlockedContent(post.pubkey, post.timestamp)
      if (unlocked) {
        // Render decrypted content. Show different label for author vs buyer.
        const labelHtml = isOwnPost
          ? `<div class="paywall-unlocked-label paywall-author-label">🔒 Paywalled post — ${escapeHtml(post.paywall_price)} XMR</div>`
          : '<div class="paywall-unlocked-label">🔓 Unlocked</div>'
        postBodyHtml = `
          <div class="post-content paywall-unlocked">
            ${labelHtml}
            ${renderMarkdown(unlocked.content || '')}
          </div>
        `
        postHasMedia = !!(unlocked.media && unlocked.media.length > 0)
      } else {
        // Locked view for non-author who hasn't paid
        const onlineStatus = isAuthorOnline(post.pubkey)
        const onlineHint = onlineStatus === 'online'
          ? '<span class="paywall-online-hint paywall-online">⚡ Author online — instant unlock</span>'
          : onlineStatus === 'offline'
            ? '<span class="paywall-online-hint paywall-offline">⏳ Author offline — unlock when they return</span>'
            : ''
        postBodyHtml = `
          <div class="post-content paywall-locked">
            <div class="paywall-preview-text">${renderMarkdown(post.paywall_preview || '')}</div>
            <div class="paywall-lock-bar">
              <span class="paywall-lock-icon">🔒</span>
              <span class="paywall-price-tag">${escapeHtml(post.paywall_price)} XMR</span>
              <button class="paywall-unlock-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">Unlock</button>
            </div>
            ${onlineHint}
          </div>
        `
        postHasMedia = false
      }
    } else {
      postBodyHtml = `<div class="post-content">${renderMarkdown(post.content || '')}</div>`
    }

    return `
    <div class="post-wrapper">
      ${repostHeader}
      <div class="post" data-pubkey="${safePk}" data-timestamp="${safeTs}">
        <div class="post-header">
          ${getAvatarHtml(post.pubkey, 'post')}
          <span class="post-author" data-pubkey="${safePk}">${escapeHtml(displayName)}</span>${getOnlineDotHtml(post.pubkey)}${supporterBadge}
          <span class="post-time">${formatTime(post.timestamp)}</span>
          ${isOwnPost && !repostInfo
            ? `<button class="delete-btn" data-timestamp="${safeTs}" title="Delete">&#128465;</button>`
            : repostInfo && repostInfo.repostedBy === myPubkey
              ? `<button class="delete-btn" data-timestamp="${escapeHtml(String(repostInfo.repostTimestamp || ''))}" data-is-repost="true" title="Delete repost">&#128465;</button>`
              : ''}
        </div>
        <div class="post-body">
          ${cwLabel ? `
            <div class="cw-wrapper" data-pubkey="${safePk}" data-timestamp="${safeTs}">
              <div class="cw-placeholder">
                <span class="cw-icon">⚠</span>
                <span class="cw-label">${escapeHtml(cwLabel)}</span>
                <button class="cw-reveal-btn" type="button">Show content</button>
              </div>
              <div class="cw-content hidden">
                ${postBodyHtml}
                ${postHasMedia ? `<div class="post-media" data-media-pubkey="${safePk}" data-media-ts="${safeTs}"></div>` : ''}
              </div>
            </div>
          ` : `
            ${postBodyHtml}
            ${postHasMedia ? `<div class="post-media" data-media-pubkey="${safePk}" data-media-ts="${safeTs}"></div>` : ''}
          `}
        </div>
        <div class="post-actions">
          ${!isOwnPost ? `<button class="action-btn like-btn ${liked ? 'liked' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="Like">
            <span class="action-icon">${liked ? '\u2764' : '\u2661'}</span>
            <span class="action-count">${counts.likes || ''}</span>
          </button>` : `<span class="action-placeholder"></span>`}
          <button class="action-btn repost-btn ${reposted ? 'reposted' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="Repost">
            <span class="action-icon">\u21BB</span>
            <span class="action-count">${counts.reposts || ''}</span>
          </button>
          <button class="action-btn reply-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="Reply">
            <span class="action-icon">\u{1F4AC}</span>
            <span class="action-count">${counts.replies || ''}</span>
          </button>
          <button class="action-btn bookmark-btn ${isBookmarked(post.pubkey, post.timestamp) ? 'bookmarked' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="${isBookmarked(post.pubkey, post.timestamp) ? 'Remove bookmark' : 'Bookmark'}">
            <span class="action-icon">${isBookmarked(post.pubkey, post.timestamp) ? '\u{1F516}' : '\u{1F4D1}'}</span>
          </button>
          <button class="action-btn tip-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}" data-is-own="${isOwnPost}" title="Send tip">
            <svg class="action-icon monero-icon" viewBox="0 0 496 512" width="20" height="20"><path fill="currentColor" d="M352 384h108.4C417 455.9 338.1 504 248 504S79 455.9 35.6 384H144V256.2L248 361l104-105v128zM88 336V128l159.4 159.4L408 128v208h74.8c8.5-25.1 13.2-52 13.2-80C496 119 385 8 248 8S0 119 0 256c0 28 4.6 54.9 13.2 80H88z"/></svg>
          </button>
        </div>
        <div class="inline-repost-form hidden" data-pubkey="${safePk}" data-timestamp="${safeTs}">
          <textarea class="inline-repost-input" placeholder="Add a comment (optional)..." rows="2"></textarea>
          <div class="inline-repost-actions">
            <button class="cancel-repost-btn">Cancel</button>
            <button class="send-repost-btn">Repost</button>
          </div>
        </div>
        <div class="inline-reply-form hidden" data-pubkey="${safePk}" data-timestamp="${safeTs}">
          <div class="inline-reply-toolbar">
            <button type="button" class="toolbar-btn inline-bold-btn" title="Bold">B</button>
            <button type="button" class="toolbar-btn inline-italic-btn" title="Italic"><em>I</em></button>
            <button type="button" class="toolbar-btn inline-code-btn" title="Code">&lt;/&gt;</button>
            <button type="button" class="toolbar-btn inline-link-btn" title="Link">&#128279;</button>
            <div class="toolbar-divider"></div>
            <button type="button" class="toolbar-btn inline-media-btn" title="Attach image/video">&#128247;</button>
            <button type="button" class="toolbar-btn inline-file-btn" title="Attach file">&#128206;</button>
            <button type="button" class="toolbar-btn inline-emoji-btn" title="Emoji">&#128512;</button>
          </div>
          <div style="position: relative;">
            <div class="emoji-picker inline-emoji-picker hidden">
              <div class="emoji-grid inline-emoji-grid"></div>
            </div>
          </div>
          <textarea class="inline-reply-input" placeholder="Write a reply..." rows="2"></textarea>
          <div class="inline-media-preview media-preview"></div>
          <input type="file" class="inline-media-input" accept="image/*,video/*" multiple style="display: none;">
          <input type="file" class="inline-file-input" multiple style="display: none;">
          <div class="inline-reply-actions">
            <button class="cancel-reply-btn">Cancel</button>
            <button class="send-reply-btn">Reply</button>
          </div>
        </div>
        ${repliesHtml}
        ${hiddenRepliesHtml}
      </div>
    </div>
  `
  }

  // Render a poll card. Tally is computed from the current timeline via
  // tallyPollVotes, which runs verifyEventSignature per vote, dedupes by voter
  // pubkey (latest wins, tiebreak by Hypercore _seq), and drops votes past
  // poll.expires_at. Option labels are escaped here and in the result bars.
  function renderPollCard(poll) {
    const displayName = getDisplayName(poll.pubkey, state.identity, state.myProfile, state.peerProfiles)
    const isOwnPoll = poll.pubkey === myPubkey
    const safePk = escapeHtml(poll.pubkey || '')
    const safeTs = escapeHtml(String(poll.timestamp || ''))
    const expiresAt = Number(poll.expires_at)
    const nowMs = Date.now()
    const ended = !Number.isFinite(expiresAt) || nowMs >= expiresAt

    const supporterManager = getSupporterManager()
    const isSupporter = supporterManager?.isListed(poll.pubkey)
    const supporterBadge = isSupporter ? '<span class="supporter-badge" title="Supporter"><span class="badge-icon">&#9733;</span>Supporter</span>' : ''

    const { counts, total, voters } = tallyPollVotes(poll, posts, nowMs)
    const myVoteIndex = myPubkey ? voters.get(myPubkey.toLowerCase()) : undefined
    const hasVoted = typeof myVoteIndex === 'number'

    // Render options. Showing the vote button is disabled once the poll has
    // ended, after the viewer has voted, or for the author's own poll.
    const canVote = !ended && !hasVoted && !isOwnPoll
    const optionsHtml = poll.options.map((label, idx) => {
      const votes = counts[idx] || 0
      const pct = total > 0 ? Math.round((votes / total) * 100) : 0
      const selected = hasVoted && myVoteIndex === idx ? ' poll-option-selected' : ''
      const barHtml = (ended || hasVoted)
        ? `<div class="poll-option-bar" style="width:${pct}%"></div>`
        : ''
      const voteBtnHtml = canVote
        ? `<button class="poll-vote-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}" data-option="${idx}">Vote</button>`
        : ''
      const countHtml = (ended || hasVoted)
        ? `<span class="poll-option-count">${votes} &middot; ${pct}%</span>`
        : ''
      return `
        <div class="poll-option${selected}">
          ${barHtml}
          <div class="poll-option-body">
            <span class="poll-option-label">${escapeHtml(label)}</span>
            ${countHtml}
            ${voteBtnHtml}
          </div>
        </div>
      `
    }).join('')

    const timeLeft = ended
      ? 'Poll ended'
      : `Ends ${formatTime(expiresAt)}`
    const warningHtml = canVote
      ? '<div class="poll-vote-warning">&#9888; Votes are public and signed &mdash; anyone can see your choice.</div>'
      : ''
    const question = poll.question || ''

    return `
      <div class="post-wrapper">
        <div class="post poll-card" data-pubkey="${safePk}" data-timestamp="${safeTs}">
          <div class="post-header">
            ${getAvatarHtml(poll.pubkey, 'post')}
            <span class="post-author" data-pubkey="${safePk}">${escapeHtml(displayName)}</span>${getOnlineDotHtml(poll.pubkey)}${supporterBadge}
            <span class="post-time">${formatTime(poll.timestamp)}</span>
            ${isOwnPoll ? `<button class="delete-btn" data-timestamp="${safeTs}" title="Delete poll">&#128465;</button>` : ''}
          </div>
          <div class="post-body">
            <div class="poll-question">${escapeHtml(question)}</div>
            <div class="poll-options">${optionsHtml}</div>
            <div class="poll-meta">
              <span class="poll-total">${total} vote${total === 1 ? '' : 's'}</span>
              <span class="poll-time-left">${escapeHtml(timeLeft)}</span>
            </div>
            ${warningHtml}
          </div>
        </div>
      </div>
    `
  }

  // Render a top-level "my reply" card (only appears when "My posts" is toggled on)
  function renderMyReplyCard(reply) {
    const hasReplyMedia = reply.media && reply.media.length > 0
    const displayName = getDisplayName(reply.pubkey, state.identity, state.myProfile, state.peerProfiles)
    const parentName = getDisplayName(reply.to_pubkey, state.identity, state.myProfile, state.peerProfiles)
    const safePk = escapeHtml(reply.pubkey || '')
    const safeTs = escapeHtml(String(reply.timestamp || ''))
    const safeParentPk = escapeHtml(reply.to_pubkey || '')
    const safeParentTs = escapeHtml(String(reply.post_timestamp || ''))

    return `
      <div class="post my-reply-card" data-pubkey="${safeParentPk}" data-timestamp="${safeParentTs}">
        <div class="my-reply-context">↳ Replying to <span class="post-author" data-pubkey="${safeParentPk}">@${escapeHtml(parentName)}</span></div>
        <div class="post-header">
          ${getAvatarHtml(reply.pubkey, 'post')}
          <div class="post-author-info">
            <span class="post-author" data-pubkey="${safePk}">${escapeHtml(displayName)}</span>
            <span class="post-time">${formatTime(reply.timestamp)}</span>
          </div>
          <button class="delete-btn" data-timestamp="${safeTs}" data-is-reply="true" title="Delete reply">&#128465;</button>
        </div>
        <div class="post-content">${renderMarkdown(reply.content || '')}</div>
        ${hasReplyMedia ? `<div class="reply-media" data-media-pubkey="${safePk}" data-media-ts="${safeTs}"></div>` : ''}
      </div>
    `
  }

  // Build HTML for visible items only
  let postsHtml = visibleItems.map((item, idx) => {
    if (item.type === 'repost') {
      return renderPostWithReplies(item.post, idx, {
        repostedBy: item.repostedBy,
        comment: item.comment,
        repostTimestamp: item.timestamp
      })
    } else if (item.type === 'myreply') {
      return renderMyReplyCard(item.reply)
    } else if (item.type === 'poll') {
      return renderPollCard(item.poll)
    } else {
      return renderPostWithReplies(item.post, idx)
    }
  }).join('')

  // Add "Load more" button if there are more items
  if (hasMoreItems) {
    const remainingCount = totalItems - state.timelineVisibleCount
    postsHtml += `
      <div class="load-more-container">
        <button class="load-more-btn" id="loadMoreBtn">
          Load more (${remainingCount} remaining)
        </button>
      </div>
    `
  }

  dom.postsEl.innerHTML = postsHtml

  // Add "Load more" button handler
  const loadMoreBtn = document.getElementById('loadMoreBtn')
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', async () => {
      state.timelineVisibleCount += state.timelinePageSize
      await renderPosts(posts, refreshUI)
    })
  }

  // Add author click handlers (posts and replies)
  dom.postsEl.querySelectorAll('.post-author, .reply-author').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = el.dataset.pubkey
      if (onAuthorClickCallback) {
        onAuthorClickCallback(pubkey, state.currentTimeline)
      }
    })
  })

  // Content-warning reveal handlers
  dom.postsEl.querySelectorAll('.cw-reveal-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const wrapper = btn.closest('.cw-wrapper')
      if (!wrapper) return
      wrapper.classList.add('cw-revealed')
      const content = wrapper.querySelector('.cw-content')
      if (content) content.classList.remove('hidden')
    })
  })

  // Reply-collapse expand handlers
  dom.postsEl.querySelectorAll('.replies-expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const postEl = btn.closest('.post')
      if (!postEl) return
      const pk = postEl.dataset.pubkey
      const ts = postEl.dataset.timestamp
      if (pk && ts) expandedReplyThreads.add(`${pk}:${ts}`)
      renderPosts(posts, refreshUI)
    })
  })

  // Add delete handlers
  dom.postsEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const isRepost = btn.dataset.isRepost === 'true'
      const isReply = btn.dataset.isReply === 'true'
      const message = isRepost
        ? 'Delete this repost?'
        : isReply
          ? 'Delete this reply?'
          : 'Delete this post?'
      if (!confirm(message)) return
      btn.disabled = true
      try {
        await state.feed.append(createDeleteEvent({ postTimestamp: parseInt(btn.dataset.timestamp) }))
        schedulePublicSiteRebuild()
        await refreshUI()
      } catch (err) {
        alert('Error deleting: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add paywall unlock handlers
  dom.postsEl.querySelectorAll('.paywall-unlock-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp)
      const post = state.currentTimeline.find(p =>
        p.type === 'post' && p.pubkey === pubkey && p.timestamp === timestamp
      )
      if (post) {
        showPaywallUnlockModal(post)
      }
    })
  })

  // Poll vote handlers. Votes are signed by feed.append at send time so the
  // timestamp used for the expires_at check is the feed-signed one, not
  // user-supplied. Aggregator enforces dedupe + bounds + signature checks at
  // render.
  dom.postsEl.querySelectorAll('.poll-vote-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const authorPubkey = btn.dataset.pubkey
      const pollTimestamp = parseInt(btn.dataset.timestamp, 10)
      const optionIndex = parseInt(btn.dataset.option, 10)
      const poll = state.currentTimeline.find(p =>
        p.type === 'poll' && p.pubkey === authorPubkey && p.timestamp === pollTimestamp
      )
      if (!poll || !validatePollEvent(poll)) return
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= poll.options.length) return
      if (Date.now() >= Number(poll.expires_at)) return
      if (authorPubkey === myPubkey) return
      // Confirm once so users understand the public + signed nature.
      const ok = confirm(
        'Votes are public and signed by your feed. Anyone replicating your feed can see your choice.\n\nSubmit your vote?'
      )
      if (!ok) return
      btn.disabled = true
      try {
        await state.feed.append(createPollVoteEvent({
          pollAuthorPubkey: authorPubkey,
          pollTimestamp,
          optionIndex
        }))
        await refreshUI()
      } catch (err) {
        alert('Error submitting vote: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add like handlers
  dom.postsEl.querySelectorAll('.like-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)

      // Check if already liked
      if (hasLiked(state.currentTimeline, myPubkey, toPubkey, postTimestamp)) {
        return // Already liked, can't unlike (append-only)
      }

      btn.disabled = true
      try {
        await state.feed.append(createLikeEvent({ toPubkey, postTimestamp }))
        await refreshUI()
      } catch (err) {
        alert('Error liking: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add repost handlers - show inline repost form
  dom.postsEl.querySelectorAll('.repost-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = btn.dataset.timestamp

      // Check if already reposted
      if (hasReposted(state.currentTimeline, myPubkey, pubkey, parseInt(timestamp))) {
        return // Already reposted
      }

      const form = dom.postsEl.querySelector(`.inline-repost-form[data-pubkey="${pubkey}"][data-timestamp="${timestamp}"]`)
      if (form) {
        // Hide all other forms first
        dom.postsEl.querySelectorAll('.inline-repost-form').forEach(f => f.classList.add('hidden'))
        dom.postsEl.querySelectorAll('.inline-reply-form').forEach(f => f.classList.add('hidden'))
        form.classList.remove('hidden')
        form.querySelector('.inline-repost-input').focus()
      }
    })
  })

  // Add cancel repost handlers
  dom.postsEl.querySelectorAll('.cancel-repost-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const form = btn.closest('.inline-repost-form')
      form.classList.add('hidden')
      form.querySelector('.inline-repost-input').value = ''
    })
  })

  // Add send repost handlers
  dom.postsEl.querySelectorAll('.send-repost-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const form = btn.closest('.inline-repost-form')
      const input = form.querySelector('.inline-repost-input')
      const comment = input.value.trim()

      const toPubkey = form.dataset.pubkey
      const postTimestamp = parseInt(form.dataset.timestamp)

      btn.disabled = true
      try {
        await state.feed.append(createRepostEvent({ toPubkey, postTimestamp, comment: comment || null }))
        input.value = ''
        form.classList.add('hidden')
        await refreshUI()
      } catch (err) {
        alert('Error reposting: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add reply handlers - show inline reply form
  dom.postsEl.querySelectorAll('.reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = btn.dataset.timestamp
      const form = dom.postsEl.querySelector(`.inline-reply-form[data-pubkey="${pubkey}"][data-timestamp="${timestamp}"]`)
      if (form) {
        // Hide all other reply forms first
        dom.postsEl.querySelectorAll('.inline-reply-form').forEach(f => f.classList.add('hidden'))
        form.classList.remove('hidden')
        form.querySelector('.inline-reply-input').focus()
      }
    })
  })

  // Add cancel reply handlers
  dom.postsEl.querySelectorAll('.cancel-reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const form = btn.closest('.inline-reply-form')
      form.classList.add('hidden')
      form.querySelector('.inline-reply-input').value = ''
      // Clear pending media
      inlineReplyMedia.set(form, { media: [], files: [] })
      const preview = form.querySelector('.inline-media-preview')
      if (preview) preview.innerHTML = ''
    })
  })

  // Add send reply handlers
  dom.postsEl.querySelectorAll('.send-reply-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const form = btn.closest('.inline-reply-form')
      const input = form.querySelector('.inline-reply-input')
      const content = input.value.trim()
      const pending = inlineReplyMedia.get(form) || { media: [], files: [] }

      // Allow sending with just media/files, no text required
      if (!content && pending.media.length === 0 && pending.files.length === 0) return

      const toPubkey = form.dataset.pubkey
      const postTimestamp = parseInt(form.dataset.timestamp)

      btn.disabled = true
      try {
        // Upload pending media
        const uploadedMedia = []
        if (state.media && pending.media.length > 0) {
          for (const file of pending.media) {
            let result
            if (file.type.startsWith('video/')) {
              result = await state.media.storeVideo(file, file.name)
            } else {
              result = await state.media.storeImage(file, file.name)
            }
            uploadedMedia.push(result)
          }
        }

        // Upload pending files
        if (state.media && pending.files.length > 0) {
          for (const file of pending.files) {
            const result = await state.media.storeFile(file, file.name)
            uploadedMedia.push(result)
          }
        }

        const replyEvent = await state.feed.append(createReplyEvent({
          toPubkey,
          postTimestamp,
          content,
          media: uploadedMedia.length > 0 ? uploadedMedia : undefined
        }))
        input.value = ''
        form.classList.add('hidden')

        // Clear pending media
        inlineReplyMedia.set(form, { media: [], files: [] })
        const preview = form.querySelector('.inline-media-preview')
        if (preview) preview.innerHTML = ''

        // Send reply notification to OP if they don't follow us
        if (state.replyNotify && toPubkey !== state.identity?.pubkeyHex) {
          const opSwarmId = state.pubkeyToSwarmId?.[toPubkey]
          if (opSwarmId && !state.feed.followers.has(opSwarmId)) {
            const myProfile = state.myProfile || {}
            state.replyNotify.notifyReply({
              opPubkey: toPubkey,
              opSwarmId,
              postTimestamp,
              reply: replyEvent,
              author: {
                name: myProfile.name || '',
                swarmId: state.feed.swarmId,
                avatar: myProfile.avatar
              }
            }).catch(err => console.warn('[Timeline] Error sending reply notification:', err.message))
          }
        }

        await refreshUI()
      } catch (err) {
        alert('Error replying: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add inline reply toolbar handlers (formatting)
  dom.postsEl.querySelectorAll('.inline-reply-form').forEach(form => {
    const input = form.querySelector('.inline-reply-input')

    // Bold button
    form.querySelector('.inline-bold-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      wrapSelection(input, '**', '**')
    })

    // Italic button
    form.querySelector('.inline-italic-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      wrapSelection(input, '_', '_')
    })

    // Code button
    form.querySelector('.inline-code-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      wrapSelection(input, '`', '`')
    })

    // Link button
    form.querySelector('.inline-link-btn')?.addEventListener('click', (e) => {
      e.stopPropagation()
      const url = prompt('Enter URL:')
      if (url) {
        const selectedText = input.value.substring(input.selectionStart, input.selectionEnd)
        const linkText = selectedText || 'link text'
        insertAtCursor(input, `[${linkText}](${url})`)
      }
    })

    // Emoji button
    const emojiBtn = form.querySelector('.inline-emoji-btn')
    const emojiPicker = form.querySelector('.inline-emoji-picker')
    const emojiGrid = form.querySelector('.inline-emoji-grid')
    if (emojiBtn && emojiPicker && emojiGrid) {
      initEmojiPicker(emojiGrid, (emoji) => {
        insertAtCursor(input, emoji)
        emojiPicker.classList.add('hidden')
      })
      emojiBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        emojiPicker.classList.toggle('hidden')
      })
    }

    // Media upload button
    const mediaBtn = form.querySelector('.inline-media-btn')
    const mediaInput = form.querySelector('.inline-media-input')
    const mediaPreview = form.querySelector('.inline-media-preview')
    if (mediaBtn && mediaInput) {
      mediaBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        mediaInput.click()
      })
      mediaInput.addEventListener('change', () => {
        const pending = inlineReplyMedia.get(form) || { media: [], files: [] }
        for (const file of mediaInput.files) {
          pending.media.push(file)
          // Show preview
          const previewItem = document.createElement('div')
          previewItem.className = 'media-preview-item'
          if (file.type.startsWith('video/')) {
            previewItem.innerHTML = `<span class="preview-filename">📹 ${escapeHtml(file.name)}</span>`
          } else {
            const img = document.createElement('img')
            img.src = URL.createObjectURL(file)
            previewItem.appendChild(img)
          }
          const removeBtn = document.createElement('button')
          removeBtn.className = 'remove-preview'
          removeBtn.textContent = '×'
          removeBtn.onclick = (e) => {
            e.stopPropagation()
            const idx = pending.media.indexOf(file)
            if (idx > -1) pending.media.splice(idx, 1)
            previewItem.remove()
          }
          previewItem.appendChild(removeBtn)
          mediaPreview.appendChild(previewItem)
        }
        inlineReplyMedia.set(form, pending)
        mediaInput.value = ''
      })
    }

    // File attachment button
    const fileBtn = form.querySelector('.inline-file-btn')
    const fileInput = form.querySelector('.inline-file-input')
    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        fileInput.click()
      })
      fileInput.addEventListener('change', () => {
        const pending = inlineReplyMedia.get(form) || { media: [], files: [] }
        for (const file of fileInput.files) {
          // Route images/videos to the media queue so EXIF stripping runs.
          const isImageOrVideo = file.type?.startsWith('image/') || file.type?.startsWith('video/')
          const previewItem = document.createElement('div')
          if (isImageOrVideo) {
            pending.media.push(file)
            previewItem.className = 'media-preview-item'
            if (file.type.startsWith('video/')) {
              previewItem.innerHTML = `<span class="preview-filename">📹 ${escapeHtml(file.name)}</span>`
            } else {
              const img = document.createElement('img')
              img.src = URL.createObjectURL(file)
              previewItem.appendChild(img)
            }
          } else {
            pending.files.push(file)
            previewItem.className = 'media-preview-item file-preview'
            previewItem.innerHTML = `<span class="preview-filename">📎 ${escapeHtml(file.name)}</span>`
          }
          const removeBtn = document.createElement('button')
          removeBtn.className = 'remove-preview'
          removeBtn.textContent = '×'
          removeBtn.onclick = (e) => {
            e.stopPropagation()
            const queue = isImageOrVideo ? pending.media : pending.files
            const idx = queue.indexOf(file)
            if (idx > -1) queue.splice(idx, 1)
            previewItem.remove()
          }
          previewItem.appendChild(removeBtn)
          mediaPreview.appendChild(previewItem)
        }
        inlineReplyMedia.set(form, pending)
        fileInput.value = ''
      })
    }
  })

  // Add bookmark handlers (toggle)
  dom.postsEl.querySelectorAll('.bookmark-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp, 10)
      if (!pubkey || !Number.isFinite(timestamp)) return
      btn.disabled = true
      try {
        if (isBookmarked(pubkey, timestamp)) {
          await removeBookmark(state.feed, state.identity, pubkey, timestamp)
        } else {
          await addBookmark(state.feed, state.identity, pubkey, timestamp)
        }
        await refreshUI()
      } catch (err) {
        alert('Error bookmarking: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add tip handlers
  dom.postsEl.querySelectorAll('.tip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Check if this is the user's own post
      if (btn.dataset.isOwn === 'true') {
        alert("You can't tip your own post")
        return
      }
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp)
      const post = state.currentTimeline.find(p =>
        p.pubkey === pubkey && p.timestamp === timestamp
      )
      if (post) showTipModal(post)
    })
  })

  // Add reply tip handlers
  dom.postsEl.querySelectorAll('.reply-tip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      // Check if this is the user's own reply
      if (btn.dataset.isOwn === 'true') {
        alert("You can't tip your own post")
        return
      }
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp)
      const reply = state.currentTimeline.find(p =>
        p.type === 'reply' && p.pubkey === pubkey && p.timestamp === timestamp
      )
      if (reply) showTipModal(reply)
    })
  })

  // Add reply repost handlers (repost button on replies in center column) - show inline form
  dom.postsEl.querySelectorAll('.reply-repost-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = btn.dataset.timestamp

      // Check if already reposted
      if (hasReposted(state.currentTimeline, myPubkey, pubkey, parseInt(timestamp))) {
        return // Already reposted
      }

      // Find the form within this reply
      const reply = btn.closest('.reply')
      const form = reply?.querySelector('.inline-repost-form')
      if (form) {
        // Hide all other forms first
        dom.postsEl.querySelectorAll('.inline-repost-form').forEach(f => f.classList.add('hidden'))
        dom.postsEl.querySelectorAll('.inline-reply-form').forEach(f => f.classList.add('hidden'))
        form.classList.remove('hidden')
        form.querySelector('.inline-repost-input').focus()
      }
    })
  })

  // Add reply reply handlers (reply button on replies in center column)
  // Opens thread view focused on the reply so user can use the proper composer
  dom.postsEl.querySelectorAll('.reply-reply-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp)
      // Open thread view - the thread composer can be used to reply
      if (onThreadClickCallback) {
        onThreadClickCallback(pubkey, timestamp, false)
      }
    })
  })

  // Add tip info badge click handlers - show tip details
  dom.postsEl.querySelectorAll('.tip-info-badge').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation()
      const count = badge.dataset.count
      const amount = badge.dataset.amount
      const tipLabel = count === '1' ? 'tip' : 'tips'
      alert(`${count} ${tipLabel} received\nTotal: ${amount} XMR`)
    })
  })

  // Add post click handlers - open thread view
  dom.postsEl.querySelectorAll('.post').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't trigger if clicking on author, buttons, links, reply form, or hidden replies indicator
      if (e.target.closest('.post-author, .action-btn, .delete-btn, a, .inline-reply-form, .hidden-replies-indicator')) return
      const pubkey = el.dataset.pubkey
      const timestamp = parseInt(el.dataset.timestamp)
      if (onThreadClickCallback) {
        onThreadClickCallback(pubkey, timestamp, false)
      }
    })
  })

  // Add follow handlers for hidden repliers
  dom.postsEl.querySelectorAll('.follow-hidden-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const swarmId = btn.dataset.swarmId
      const name = btn.dataset.name || swarmId.slice(0, 8) + '...'
      if (!swarmId) return

      // Skip if already being followed
      if (state.pendingFollows.has(swarmId)) return

      // Add to pending follows to prevent button flicker during re-renders
      state.pendingFollows.add(swarmId)

      // Immediately update button to show processing state
      btn.disabled = true
      btn.textContent = 'Following, please wait...'
      btn.classList.add('processing')

      // Also update the row opacity
      const replierRow = btn.closest('.hidden-replier')
      if (replierRow) {
        replierRow.style.opacity = '0.5'
      }

      try {
        // Append follow event and join swarm
        const { createFollowEvent } = await import('../../lib/events.js')
        await state.feed.append(createFollowEvent({ swarmId }))
        await state.feed.follow(swarmId)

        // Show toast notification immediately - user can continue browsing
        showToast('Following User', `@${name} - syncing their posts...`, 'success')

        // The feed's onDataUpdate callback will trigger refreshUI when data arrives
        // Remove from pendingFollows after the delayed toast to allow UI to settle
        setTimeout(async () => {
          state.pendingFollows.delete(swarmId)
          showToast('User Followed!', `@${name}'s posts will appear in your feed`, 'success')
          // Trigger a refresh to show the now-visible reply
          if (refreshUICallback) await refreshUICallback()
        }, 3000)

      } catch (err) {
        console.error('Error following hidden replier:', err)
        state.pendingFollows.delete(swarmId)
        btn.disabled = false
        btn.textContent = 'Follow'
        btn.classList.remove('processing')
        if (replierRow) {
          replierRow.style.opacity = '1'
        }
        showToast('Error', `Failed to follow @${name}`, 'error')
      }
    })
  })

  // Load media asynchronously - find all media containers for posts
  const mediaContainers = dom.postsEl.querySelectorAll('.post-media[data-media-pubkey]')
  for (const mediaContainer of mediaContainers) {
    const pubkey = mediaContainer.dataset.mediaPubkey
    const ts = parseInt(mediaContainer.dataset.mediaTs)

    // Find the post with this pubkey+timestamp
    const post = postEvents.find(p => p.pubkey === pubkey && p.timestamp === ts)

    // For unlocked paywalled posts, the media lives in the decrypted content
    let mediaList = post?.media
    if (post && isPaywalledPost(post)) {
      const unlocked = getUnlockedContent(post.pubkey, post.timestamp)
      if (unlocked && unlocked.media && unlocked.media.length > 0) {
        mediaList = unlocked.media
      }
    }

    if (post && mediaList && mediaList.length > 0 && state.media) {
      try {
        await renderMediaCollection(mediaContainer, post.pubkey, mediaList)
      } catch (err) {
        console.error('Error rendering post media collection:', err)
      }
    }
  }

  // Load images for reply media
  const replyMediaContainers = dom.postsEl.querySelectorAll('.reply-media[data-media-pubkey]')
  for (const mediaContainer of replyMediaContainers) {
    const pubkey = mediaContainer.dataset.mediaPubkey
    const ts = parseInt(mediaContainer.dataset.mediaTs)

    // Find the reply with this pubkey+timestamp
    const reply = posts.find(p => p.type === 'reply' && p.pubkey === pubkey && p.timestamp === ts)
    if (reply && reply.media && reply.media.length > 0 && state.media) {
      try {
        await renderMediaCollection(mediaContainer, reply.pubkey, reply.media)
      } catch (err) {
        console.error('Error rendering reply media collection:', err)
      }
    }
  }
}

/**
 * Set the refresh UI callback for thread operations
 */
export function setRefreshUICallback(callback) {
  refreshUICallback = callback
}

/**
 * Show a thread in the center column (replacing the timeline)
 * Returns a function to restore the regular timeline
 */
export async function showThreadInCenter(rootPubkey, rootTimestamp) {
  centerViewActive = true
  const timeline = state.currentTimeline
  const { buildThread, getInteractionCounts, hasLiked, hasReposted, createReplyEvent, createLikeEvent, createRepostEvent } = await import('../../lib/events.js')

  const thread = buildThread(timeline, rootPubkey, rootTimestamp)
  if (!thread) {
    return null
  }

  const myPubkey = state.identity?.pubkeyHex

  // Helper to get avatar HTML
  function getAvatarHtml(pubkey) {
    const isMe = pubkey === myPubkey
    const profile = isMe ? state.myProfile : state.peerProfiles[pubkey]
    const displayName = getDisplayName(pubkey, state.identity, state.myProfile, state.peerProfiles)
    const initial = displayName.charAt(0).toUpperCase()

    const safeAvatar = safeAvatarUrl(profile?.avatar)
    if (safeAvatar) {
      return `<div class="post-avatar"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
    }
    return `<div class="post-avatar">${initial}</div>`
  }

  // Render thread post
  function renderThreadPost(post, isRoot = false) {
    const displayName = getDisplayName(post.pubkey, state.identity, state.myProfile, state.peerProfiles)
    const counts = getInteractionCounts(timeline, post.pubkey, post.timestamp)
    const liked = hasLiked(timeline, myPubkey, post.pubkey, post.timestamp)
    const reposted = hasReposted(timeline, myPubkey, post.pubkey, post.timestamp)
    const isOwnPost = post.pubkey === myPubkey
    const hasMedia = post.media && post.media.length > 0
    const threadSupporterManager = getSupporterManager()
    const threadIsSupporter = threadSupporterManager?.isListed(post.pubkey)
    const threadSupporterBadge = threadIsSupporter ? '<span class="supporter-badge" title="Supporter"><span class="badge-icon">★</span>Supporter</span>' : ''
    const safePk = escapeHtml(post.pubkey || '')
    const safeTs = escapeHtml(String(post.timestamp || ''))

    const rawCw = (typeof post.cw === 'string') ? post.cw.trim() : ''
    const cwLabel = (rawCw && rawCw.length <= 200) ? rawCw : ''
    const threadContentHtml = `<div class="thread-post-content">${renderMarkdown(post.content || '')}</div>`
    const threadMediaHtml = hasMedia ? `<div class="thread-post-media" data-media-pubkey="${safePk}" data-media-ts="${safeTs}"></div>` : ''
    const threadBodyHtml = cwLabel ? `
      <div class="cw-wrapper" data-pubkey="${safePk}" data-timestamp="${safeTs}">
        <div class="cw-placeholder">
          <span class="cw-icon">⚠</span>
          <span class="cw-label">${escapeHtml(cwLabel)}</span>
          <button class="cw-reveal-btn" type="button">Show content</button>
        </div>
        <div class="cw-content hidden">
          ${threadContentHtml}
          ${threadMediaHtml}
        </div>
      </div>
    ` : `
      ${threadContentHtml}
      ${threadMediaHtml}
    `

    return `
      <div class="thread-post ${isRoot ? 'thread-root' : 'thread-reply'}" data-pubkey="${safePk}" data-timestamp="${safeTs}">
        <div class="thread-post-header">
          ${getAvatarHtml(post.pubkey)}
          <span class="thread-post-author">${escapeHtml(displayName)}</span>${getOnlineDotHtml(post.pubkey)}${threadSupporterBadge}
          <span class="thread-post-time">${formatTime(post.timestamp)}</span>
        </div>
        ${threadBodyHtml}
        <div class="thread-post-actions">
          ${!isOwnPost ? `<button class="action-btn center-like-btn ${liked ? 'liked' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}">
            <span class="action-icon">${liked ? '\u2764' : '\u2661'}</span>
            <span class="action-count">${counts.likes || ''}</span>
          </button>` : '<span class="action-placeholder"></span>'}
          <button class="action-btn center-repost-btn ${reposted ? 'reposted' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}">
            <span class="action-icon">\u21BB</span>
            <span class="action-count">${counts.reposts || ''}</span>
          </button>
          <button class="action-btn center-reply-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">
            <span class="action-icon">\u{1F4AC}</span>
            <span class="action-count">${counts.replies || ''}</span>
          </button>
        </div>
        <div class="inline-reply-form hidden" data-pubkey="${safePk}" data-timestamp="${safeTs}">
          <textarea class="inline-reply-input" placeholder="Write a reply..."></textarea>
          <div class="inline-reply-actions">
            <button class="cancel-center-reply-btn">Cancel</button>
            <button class="send-center-reply-btn">Reply</button>
          </div>
        </div>
        ${post.replies && post.replies.length > 0 ? `
          <div class="thread-replies">
            ${post.replies.map(reply => renderThreadPost(reply, false)).join('')}
          </div>
        ` : ''}
      </div>
    `
  }

  // Build thread HTML with back button
  const threadHtml = `
    <div class="center-thread-view">
      <div class="center-thread-header">
        <button class="center-back-btn" id="centerBackBtn">&larr; Back to Feed</button>
        <h3>Thread</h3>
      </div>
      <div class="center-thread-content">
        <div class="thread-view">
          ${renderThreadPost(thread, true)}
        </div>
      </div>
    </div>
  `

  // Save current posts HTML
  const savedPostsHtml = dom.postsEl.innerHTML

  // Replace with thread
  dom.postsEl.innerHTML = threadHtml

  // Back button handler
  const backBtn = document.getElementById('centerBackBtn')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      centerViewActive = false
      dom.postsEl.innerHTML = savedPostsHtml
      // Re-attach event handlers by refreshing
      if (refreshUICallback) refreshUICallback()
    })
  }

  // Content-warning reveal handlers (thread view)
  dom.postsEl.querySelectorAll('.cw-reveal-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const wrapper = btn.closest('.cw-wrapper')
      if (!wrapper) return
      wrapper.classList.add('cw-revealed')
      const content = wrapper.querySelector('.cw-content')
      if (content) content.classList.remove('hidden')
    })
  })

  // Like handlers
  dom.postsEl.querySelectorAll('.center-like-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)
      if (hasLiked(timeline, myPubkey, toPubkey, postTimestamp)) return
      btn.disabled = true
      try {
        await state.feed.append(createLikeEvent({ toPubkey, postTimestamp }))
        if (refreshUICallback) {
          await refreshUICallback()
          await showThreadInCenter(rootPubkey, rootTimestamp)
        }
      } catch (err) {
        alert('Error: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Repost handlers
  dom.postsEl.querySelectorAll('.center-repost-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)
      if (hasReposted(timeline, myPubkey, toPubkey, postTimestamp)) return
      btn.disabled = true
      try {
        await state.feed.append(createRepostEvent({ toPubkey, postTimestamp }))
        if (refreshUICallback) {
          await refreshUICallback()
          await showThreadInCenter(rootPubkey, rootTimestamp)
        }
      } catch (err) {
        alert('Error: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Reply button - show inline reply form
  dom.postsEl.querySelectorAll('.center-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pubkey = btn.dataset.pubkey
      const timestamp = btn.dataset.timestamp
      const form = dom.postsEl.querySelector(`.inline-reply-form[data-pubkey="${pubkey}"][data-timestamp="${timestamp}"]`)
      if (form) {
        // Hide all other reply forms first
        dom.postsEl.querySelectorAll('.inline-reply-form').forEach(f => f.classList.add('hidden'))
        form.classList.remove('hidden')
        form.querySelector('.inline-reply-input').focus()
      }
    })
  })

  // Cancel center reply handlers
  dom.postsEl.querySelectorAll('.cancel-center-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.inline-reply-form')
      form.classList.add('hidden')
      form.querySelector('.inline-reply-input').value = ''
    })
  })

  // Send center reply handlers
  dom.postsEl.querySelectorAll('.send-center-reply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.inline-reply-form')
      const input = form.querySelector('.inline-reply-input')
      const content = input.value.trim()
      if (!content) return

      const toPubkey = form.dataset.pubkey
      const postTimestamp = parseInt(form.dataset.timestamp)

      btn.disabled = true
      try {
        const replyEvent = await state.feed.append(createReplyEvent({ toPubkey, postTimestamp, content }))
        input.value = ''
        form.classList.add('hidden')

        // Send reply notification to OP if they don't follow us
        if (state.replyNotify && toPubkey !== state.identity?.pubkeyHex) {
          const opSwarmId = state.pubkeyToSwarmId?.[toPubkey]
          if (opSwarmId && !state.feed.followers.has(opSwarmId)) {
            const myProfile = state.myProfile || {}
            state.replyNotify.notifyReply({
              opPubkey: toPubkey,
              opSwarmId,
              postTimestamp,
              reply: replyEvent,
              author: {
                name: myProfile.name || '',
                swarmId: state.feed.swarmId,
                avatar: myProfile.avatar
              }
            }).catch(err => console.warn('[Timeline] Error sending reply notification:', err.message))
          }
        }

        if (refreshUICallback) {
          await refreshUICallback()
          await showThreadInCenter(rootPubkey, rootTimestamp)
        }
      } catch (err) {
        alert('Error: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Load media
  const mediaContainers = dom.postsEl.querySelectorAll('.thread-post-media[data-media-pubkey]')
  for (const mediaContainer of mediaContainers) {
    const pubkey = mediaContainer.dataset.mediaPubkey
    const ts = parseInt(mediaContainer.dataset.mediaTs)
    const post = timeline.find(p => (p.type === 'post' || p.type === 'reply') && p.pubkey === pubkey && p.timestamp === ts)
    if (post && post.media && post.media.length > 0 && state.media) {
      try {
        await renderMediaCollection(mediaContainer, post.pubkey, post.media)
      } catch (err) {
        console.error('Error rendering thread media collection:', err)
      }
    }
  }

  return true
}

/**
 * Show a user profile in the center column (replaces timeline)
 * Used by Discovery Live Now to preview users before following
 * @param {Object} profileData - { name, bio, avatar, swarmId, pubkey, postCount, following, followers }
 */
export async function showProfileInCenter(profileData) {
  centerViewActive = true
  const { name, bio, avatar, website, swarmId } = profileData
  const displayName = name || (swarmId ? swarmId.slice(0, 12) + '...' : 'Unknown')
  const initial = displayName.charAt(0).toUpperCase()

  const safeAvatar = safeAvatarUrl(avatar)
  const avatarHtml = safeAvatar
    ? `<div class="center-profile-avatar"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
    : `<div class="center-profile-avatar"><span class="avatar-initial">${escapeHtml(initial)}</span></div>`

  const isFollowing = swarmId && state.feed?.isFollowing(swarmId)

  // Website link (only allow http/https)
  let websiteHtml = ''
  const safeUrl = safeWebsiteUrl(website)
  if (safeUrl) {
    websiteHtml = `<div class="center-profile-website"><a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(website)}</a></div>`
  }

  // Use Discovery-provided stats if available, else compute from local data
  const pubkey = profileData.pubkey || (swarmId ? state.swarmIdToPubkey?.[swarmId] : null) || null
  const hasDiscoveryStats = profileData.following || profileData.followers
  const followingList = profileData.following || []
  const followersList = profileData.followers || []
  const followingCount = hasDiscoveryStats ? followingList.length : (pubkey ? getFollowingForPubkey(pubkey).length : 0)
  const followersCount = hasDiscoveryStats ? followersList.length : (pubkey ? getFollowersCount(pubkey) : 0)
  const postCount = profileData.postCount || 0
  const showStats = hasDiscoveryStats || pubkey

  const profileHtml = `
    <div class="center-thread-view">
      <div class="center-thread-header">
        <button class="center-back-btn" id="centerBackBtn">&larr; Back</button>
        <h3>Profile</h3>
      </div>
      <div class="center-profile-content">
        ${avatarHtml}
        <div class="center-profile-name">${escapeHtml(displayName)}</div>
        ${bio ? `<div class="center-profile-bio">${escapeHtml(bio)}</div>` : ''}
        ${websiteHtml}
        <div class="center-profile-actions">
          ${isFollowing
            ? `<button class="center-profile-following center-follow-toggle" data-swarm-id="${escapeHtml(swarmId || '')}">Following</button>`
            : `<button class="btn-primary center-follow-toggle" data-swarm-id="${escapeHtml(swarmId || '')}">Follow</button>`
          }
        </div>
        ${showStats ? `
          <div class="center-profile-stats">
            <div class="stat">
              <span class="stat-value">${postCount}</span>
              <span class="stat-label">Posts</span>
            </div>
            <button class="stat profile-stat-btn" id="centerFollowingBtn" data-pubkey="${escapeHtml(pubkey || '')}">
              <span class="stat-value">${followingCount}</span>
              <span class="stat-label">Following</span>
            </button>
            <button class="stat profile-stat-btn" id="centerFollowersBtn" data-pubkey="${escapeHtml(pubkey || '')}">
              <span class="stat-value">${followersCount}</span>
              <span class="stat-label">Followers</span>
            </button>
          </div>
        ` : ''}
        ${swarmId ? `
          <div class="center-profile-swarm-id">
            <span class="swarm-id-label">Swarm ID</span>
            <code class="swarm-id-value">${escapeHtml(swarmId)}</code>
            <button class="btn-small center-copy-swarm" data-swarm-id="${escapeHtml(swarmId)}">Copy</button>
          </div>
        ` : ''}
        <div class="center-profile-hint">
          ${isFollowing
            ? 'You are following this user. Their posts appear in your timeline.'
            : 'Follow this user to see their posts in your timeline and enable direct messaging.'
          }
        </div>
      </div>
    </div>
  `

  // Save current posts HTML and visibility state
  const savedPostsHtml = dom.postsEl.innerHTML
  const wasHidden = dom.postsEl.classList.contains('hidden')

  // Hide any section that's covering the center column
  document.querySelectorAll('#discovery-section, #search-section, #trending-section, #settings-section, #storage-section, #messages-section').forEach(el => {
    if (el && !el.classList.contains('hidden')) {
      el.classList.add('hidden')
      el.dataset.hiddenByProfile = 'true'
    }
  })

  // Show postsEl and replace with profile
  dom.postsEl.classList.remove('hidden')
  dom.postsEl.innerHTML = profileHtml

  // Back button handler
  const backBtn = document.getElementById('centerBackBtn')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      centerViewActive = false
      dom.postsEl.innerHTML = savedPostsHtml
      if (wasHidden) dom.postsEl.classList.add('hidden')
      document.querySelectorAll('[data-hidden-by-profile="true"]').forEach(el => {
        el.classList.remove('hidden')
        delete el.dataset.hiddenByProfile
      })
      if (refreshUICallback) refreshUICallback()
    })
  }

  // Copy Swarm ID handler
  const copyBtn = dom.postsEl.querySelector('.center-copy-swarm')
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(copyBtn.dataset.swarmId)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy' }, 2000)
    })
  }

  // Follow/Unfollow toggle handler
  const toggleBtn = dom.postsEl.querySelector('.center-follow-toggle')
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const sid = toggleBtn.dataset.swarmId
      const currentlyFollowing = state.feed?.isFollowing(sid)
      toggleBtn.disabled = true

      try {
        const { createFollowEvent, createUnfollowEvent } = await import('../../lib/events.js')
        if (currentlyFollowing) {
          await state.feed.append(createUnfollowEvent({ swarmId: sid }))
          await state.feed.unfollow(sid)
          toggleBtn.textContent = 'Follow'
          toggleBtn.className = 'btn-primary center-follow-toggle'
          const hint = dom.postsEl.querySelector('.center-profile-hint')
          if (hint) hint.textContent = 'Follow this user to see their posts in your timeline and enable direct messaging.'
        } else {
          await state.feed.append(createFollowEvent({ swarmId: sid }))
          await state.feed.follow(sid)
          toggleBtn.textContent = 'Following'
          toggleBtn.className = 'center-profile-following center-follow-toggle'
          const hint = dom.postsEl.querySelector('.center-profile-hint')
          if (hint) hint.textContent = 'You are following this user. Their posts appear in your timeline.'
        }
        toggleBtn.disabled = false
        if (refreshUICallback) await refreshUICallback()
      } catch (err) {
        alert('Error: ' + err.message)
        toggleBtn.disabled = false
      }
    })
  }

  // Following/Followers button handlers
  const followingBtn = document.getElementById('centerFollowingBtn')
  if (followingBtn) {
    followingBtn.addEventListener('click', () => {
      if (followingList && followingList.length > 0) {
        // Use Discovery-provided list
        const overrideList = followingList.map(f => ({
          swarmId: f.swarmId,
          name: f.name || null,
          pubkey: f.swarmId ? state.swarmIdToPubkey?.[f.swarmId] : null,
          profile: null
        }))
        showFollowingModal(pubkey, overrideList)
      } else {
        showFollowingModal(followingBtn.dataset.pubkey)
      }
    })
  }

  const followersBtn = document.getElementById('centerFollowersBtn')
  if (followersBtn) {
    followersBtn.addEventListener('click', () => {
      if (followersList && followersList.length > 0) {
        const overrideList = followersList.map(f => ({
          swarmId: f.swarmId,
          name: f.name || null,
          pubkey: f.swarmId ? state.swarmIdToPubkey?.[f.swarmId] : null
        }))
        showFollowersModal(pubkey, overrideList)
      } else {
        showFollowersModal(followersBtn.dataset.pubkey)
      }
    })
  }
}
