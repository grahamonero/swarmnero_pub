/**
 * Article reading-mode view (Phase 2A long-form articles).
 *
 * Pushes a center-column panel like showThreadInCenter, but with article-
 * specific layout: cover image, title, author row, prose body (rendered
 * through the sanitizing markdown renderer), reactions cluster, tip button,
 * inline reply form, and a list of replies.
 *
 * RENDER-TIME INVARIANTS (per PHASE2-DESIGN.md HIGH #3):
 *  - Re-fetch the article from state.currentTimeline by (pubkey, timestamp).
 *    NEVER trust the click-source params as the article body.
 *  - verifyEventSignature on the resolved article AGAIN at render time.
 *  - For every reply rendered, verifyEventSignature on the reply itself.
 *  - validateArticleEvent re-checked here too — caps + cover shape.
 */

import { state, dom } from '../state.js'
import { escapeHtml, safeAvatarUrl } from '../utils/dom.js'
import { formatTime, getDisplayName, getOnlineDotHtml } from '../utils/format.js'
import {
  EventType,
  validateArticleEvent,
  createReplyEvent,
  getReplies,
  getInteractionCounts,
  getUserReaction,
  hasReposted
} from '../../lib/events.js'
import { verifyEventSignature } from '../../lib/feed.js'
import { renderArticleMarkdown } from '../utils/markdown.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'
import {
  setCenterViewActive,
  getRefreshUICallback,
  renderReactionCluster,
  wireReactionHandlers
} from './timeline.js'
import { showTipModal } from './tip.js'

/**
 * Push the article reading-mode panel into the center column.
 *
 * @param {string} articlePubkey
 * @param {number} articleTimestamp
 */
export async function showArticleInCenter(articlePubkey, articleTimestamp) {
  if (!articlePubkey || !Number.isFinite(Number(articleTimestamp))) return null

  // Resolve the article from the verified timeline. Only `state.currentTimeline`
  // is the source of truth; never use the params as content. Then re-validate
  // structure AND signature before rendering.
  const timeline = state.currentTimeline || []
  const article = timeline.find(e =>
    e && e.type === EventType.ARTICLE &&
    e.pubkey === articlePubkey &&
    Number(e.timestamp) === Number(articleTimestamp)
  )

  if (!article) {
    // Article not in current timeline — likely fetched but discarded by ingest.
    // Fall through with a friendly message rather than rendering attacker input.
    dom.postsEl.innerHTML = `
      <div class="center-thread-view">
        <div class="center-thread-header">
          <button class="center-back-btn" id="centerArticleBackBtn">&larr; Back to Feed</button>
          <h3>Article</h3>
        </div>
        <div class="article-reading-empty">Article not found in this feed.</div>
      </div>
    `
    setCenterViewActive(true)
    document.getElementById('centerArticleBackBtn')?.addEventListener('click', () => {
      setCenterViewActive(false)
      const refresh = getRefreshUICallback()
      if (refresh) refresh()
    })
    return null
  }

  if (!validateArticleEvent(article)) return null
  if (!verifyEventSignature(article)) return null

  setCenterViewActive(true)

  const myPubkey = state.identity?.pubkeyHex
  const safePk = escapeHtml(article.pubkey || '')
  const safeTs = escapeHtml(String(article.timestamp || ''))
  // PHASE 2A: every interpolation below either passes through escapeHtml or
  // goes through the sanitizing markdown renderer. Title/summary/cw/tags are
  // never rendered as markdown.
  const safeTitle = escapeHtml(article.title || '')
  const safeSummary = escapeHtml(article.summary || '')
  const safeCw = article.cw ? escapeHtml(article.cw) : ''
  const tagsHtml = Array.isArray(article.tags) && article.tags.length > 0
    ? `<div class="article-reading-tags">${article.tags.map(t => `<span class="article-tag">#${escapeHtml(t)}</span>`).join(' ')}</div>`
    : ''

  const displayName = getDisplayName(article.pubkey, state.identity, state.myProfile, state.peerProfiles)
  const supporterManager = getSupporterManager()
  const isSupporter = supporterManager?.isListed(article.pubkey)
  const supporterBadge = isSupporter ? '<span class="supporter-badge" title="Supporter"><span class="badge-icon">&#9733;</span>Supporter</span>' : ''

  const profile = (article.pubkey === myPubkey) ? state.myProfile : state.peerProfiles?.[article.pubkey]
  const safeAvatar = safeAvatarUrl(profile?.avatar)
  const avatarHtml = safeAvatar
    ? `<div class="post-avatar"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
    : `<div class="post-avatar">${escapeHtml((displayName || '?').charAt(0).toUpperCase())}</div>`

  const hasCover = !!(article.cover && article.cover.driveKey && article.cover.path)
  const coverHtml = hasCover
    ? `<div class="article-reading-cover" data-cover-pubkey="${safePk}" data-cover-ts="${safeTs}"></div>`
    : ''

  // Body: sanitized markdown. The ONLY trusted path for article HTML.
  // Paywalled articles whose body field is empty render the preview text
  // (escaped as plain text — not markdown).
  let bodyHtml
  if (article.paywall_encrypted) {
    const preview = escapeHtml(article.paywall_preview || '')
    bodyHtml = `
      <div class="article-reading-paywall">
        <div class="article-reading-preview">${preview}</div>
        <div class="article-reading-paywall-cta">
          <span class="article-reading-paywall-icon">&#128274;</span>
          <span>This article is paywalled (${escapeHtml(article.paywall_price || '')} XMR). Open the original post to unlock.</span>
        </div>
      </div>
    `
  } else {
    bodyHtml = `<div class="article-reading-body">${renderArticleMarkdown(article.body || '')}</div>`
  }

  const cwBadge = safeCw ? `<div class="article-reading-cw">&#9888; ${safeCw}</div>` : ''

  // Build replies. Articles use the existing reply event type targeting
  // (article.pubkey, article.timestamp). Each reply is signature-verified
  // here even though ingest already did — belt-and-braces per design HIGH #3.
  const directReplies = getReplies(timeline, article.pubkey, article.timestamp)
    .filter(r => verifyEventSignature(r))

  const repliesHtml = directReplies.map(r => renderArticleReply(r, myPubkey)).join('') || `
    <div class="article-reading-no-replies">No replies yet.</div>
  `

  const counts = getInteractionCounts(timeline, article.pubkey, article.timestamp)
  const reactions = counts.reactions || []
  const myReaction = getUserReaction(timeline, myPubkey, article.pubkey, article.timestamp)
  const isOwnArticle = article.pubkey === myPubkey
  const reposted = hasReposted(timeline, myPubkey, article.pubkey, article.timestamp)

  const html = `
    <div class="center-thread-view article-reading-view">
      <div class="center-thread-header">
        <button class="center-back-btn" id="centerArticleBackBtn">&larr; Back to Feed</button>
        <h3>Article</h3>
      </div>
      <div class="center-thread-content">
        <article class="article-reading">
          ${coverHtml}
          <h1 class="article-reading-title">${safeTitle}</h1>
          ${safeSummary ? `<div class="article-reading-summary">${safeSummary}</div>` : ''}
          <div class="article-reading-author-row">
            ${avatarHtml}
            <span class="article-reading-author" data-pubkey="${safePk}">${escapeHtml(displayName)}</span>
            ${getOnlineDotHtml(article.pubkey)}
            ${supporterBadge}
            <span class="article-reading-time">${formatTime(article.timestamp)}</span>
          </div>
          ${cwBadge}
          ${tagsHtml}
          ${bodyHtml}
          <div class="article-reading-actions">
            ${renderReactionCluster(reactions, myReaction, article.pubkey, article.timestamp, { isOwn: isOwnArticle })}
            <button class="action-btn article-tip-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">
              <span class="action-icon">&#128176;</span>
              <span class="action-count">${counts.replies || 0} replies</span>
            </button>
          </div>
          <div class="article-reading-reply-form">
            <textarea class="inline-reply-input article-reply-input" placeholder="Write a reply..."></textarea>
            <div class="inline-reply-actions">
              <button class="cancel-center-reply-btn" type="button">Clear</button>
              <button class="send-article-reply-btn" type="button" data-pubkey="${safePk}" data-timestamp="${safeTs}">Reply</button>
            </div>
          </div>
          <div class="article-reading-replies">
            <h4>Replies</h4>
            ${repliesHtml}
          </div>
        </article>
      </div>
    </div>
  `

  dom.postsEl.innerHTML = html

  // Back button
  document.getElementById('centerArticleBackBtn')?.addEventListener('click', () => {
    setCenterViewActive(false)
    const refresh = getRefreshUICallback()
    if (refresh) refresh()
  })

  // Reaction cluster handlers (re-uses existing wiring; refresh re-renders this panel)
  const refreshThis = async () => {
    const refresh = getRefreshUICallback()
    if (refresh) await refresh()
    await showArticleInCenter(articlePubkey, articleTimestamp)
  }
  wireReactionHandlers(dom.postsEl, timeline, myPubkey, refreshThis)

  // Tip button — same pattern as post tip
  dom.postsEl.querySelectorAll('.article-tip-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pk = btn.dataset.pubkey
      const ts = parseInt(btn.dataset.timestamp)
      // Resolve the post-like target from the timeline so showTipModal sees a
      // verified event (re-find rather than passing a partial object).
      const target = timeline.find(p => p.type === EventType.ARTICLE && p.pubkey === pk && Number(p.timestamp) === ts)
      if (!target) return
      showTipModal(target).catch(err => alert('Tip error: ' + err.message))
    })
  })

  // Reply send
  dom.postsEl.querySelectorAll('.send-article-reply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.article-reading-reply-form')
      const input = form?.querySelector('.article-reply-input')
      const content = (input?.value || '').trim()
      if (!content) return
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)
      btn.disabled = true
      try {
        await state.feed.append(createReplyEvent({ toPubkey, postTimestamp, content }))
        if (input) input.value = ''
        await refreshThis()
      } catch (err) {
        alert('Reply error: ' + err.message)
        btn.disabled = false
      }
    })
  })

  dom.postsEl.querySelectorAll('.cancel-center-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.article-reading-reply-form')
      const input = form?.querySelector('.article-reply-input')
      if (input) input.value = ''
    })
  })

  // Cover image (lightbox uses the existing carousel-lightbox plumbing
  // wired by other media renderers — for now we just resolve the URL).
  if (hasCover && state.media) {
    const coverEl = dom.postsEl.querySelector('.article-reading-cover')
    if (coverEl) {
      try {
        const url = await state.media.getImageUrl(article.cover.driveKey, article.cover.path, { noSizeCap: false })
        if (url) {
          const img = document.createElement('img')
          img.alt = ''
          img.src = url
          coverEl.innerHTML = ''
          coverEl.appendChild(img)
        }
      } catch (err) {
        console.warn('[Article] cover load failed:', err.message)
      }
    }
  }

  return true
}

/**
 * Render a single reply under an article. Title-less, sanitized via plain
 * escapeHtml (replies are short-form posts, not markdown articles).
 */
function renderArticleReply(reply, myPubkey) {
  const displayName = getDisplayName(reply.pubkey, state.identity, state.myProfile, state.peerProfiles)
  const safePk = escapeHtml(reply.pubkey || '')
  const safeTs = escapeHtml(String(reply.timestamp || ''))
  const profile = (reply.pubkey === myPubkey) ? state.myProfile : state.peerProfiles?.[reply.pubkey]
  const safeAvatar = safeAvatarUrl(profile?.avatar)
  const avatarHtml = safeAvatar
    ? `<div class="post-avatar"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
    : `<div class="post-avatar">${escapeHtml((displayName || '?').charAt(0).toUpperCase())}</div>`

  // Reply content is short-form: render as plain escaped text with line breaks
  // preserved. Articles are markdown but replies under them are not — keeps
  // the reply renderer simple and aligned with the rest of the app.
  const safeContent = escapeHtml(reply.content || '').replace(/\n/g, '<br>')

  return `
    <div class="article-reading-reply" data-pubkey="${safePk}" data-timestamp="${safeTs}">
      <div class="article-reading-reply-header">
        ${avatarHtml}
        <span class="article-reading-reply-author">${escapeHtml(displayName)}</span>
        <span class="article-reading-reply-time">${formatTime(reply.timestamp)}</span>
      </div>
      <div class="article-reading-reply-body">${safeContent}</div>
    </div>
  `
}
