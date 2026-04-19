/**
 * Follow component - follow form and following list
 */

import { state, dom } from '../state.js'
import { createFollowEvent, createUnfollowEvent } from '../../lib/events.js'
import { pushPanel } from './panel.js'
import { parseSwarmId, escapeHtml, safeAvatarUrl } from '../utils/dom.js'

/**
 * Render the following list with unfollow buttons
 */
export function renderFollowing(list, refreshUI) {
  if (!list || list.length === 0) {
    dom.followingListEl.innerHTML = '<div class="empty">Not following anyone</div>'
    return
  }

  dom.followingListEl.innerHTML = list.map(key => {
    // Look up profile name for this peer (map swarm ID -> pubkey -> profile)
    const pubkey = state.swarmIdToPubkey[key]
    const profile = pubkey ? state.peerProfiles[pubkey] : null
    const displayName = profile?.name || `${key.slice(0, 12)}...`
    const initial = displayName.charAt(0).toUpperCase()

    // Avatar HTML
    const safeAvatar = safeAvatarUrl(profile?.avatar)
    const avatarHtml = safeAvatar
      ? `<div class="following-avatar"><img src="${escapeHtml(safeAvatar)}" alt=""></div>`
      : `<div class="following-avatar">${escapeHtml(initial)}</div>`

    return `
      <div class="following-item">
        <div class="following-info">
          ${avatarHtml}
          <span class="following-name clickable" title="${escapeHtml(key)}" data-pubkey="${escapeHtml(pubkey || '')}">${escapeHtml(displayName)}</span>
        </div>
        <button class="unfollow-btn" data-key="${escapeHtml(key)}">Unfollow</button>
      </div>
    `
  }).join('')

  // Click handler for username -> open profile
  dom.followingListEl.querySelectorAll('.following-name.clickable').forEach(span => {
    span.addEventListener('click', () => {
      const pubkey = span.dataset.pubkey
      if (pubkey) {
        pushPanel('profile', { pubkey, timeline: state.currentTimeline })
      }
    })
  })

  dom.followingListEl.querySelectorAll('.unfollow-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const swarmId = btn.dataset.key
      btn.disabled = true
      btn.textContent = '...'
      try {
        await state.feed.append(createUnfollowEvent({ swarmId }))
        await state.feed.unfollow(swarmId)
        await state.feed.updateFollowers()
        await refreshUI()
      } catch (err) {
        alert('Error unfollowing: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Unfollow'
      }
    })
  })
}

/**
 * Initialize follow component - follow button handler
 */
export function initFollow(refreshUI) {
  // Enable/disable follow button based on input
  dom.followKeyEl.addEventListener('input', () => {
    dom.followBtn.disabled = !dom.followKeyEl.value.trim()
  })

  dom.followBtn.addEventListener('click', async () => {
    const input = dom.followKeyEl.value.trim()
    if (!input) return

    // Parse and validate Swarm ID
    const swarmId = parseSwarmId(input)
    if (!swarmId) {
      alert('Invalid Swarm ID. Paste a valid 64-character hex ID.')
      return
    }

    dom.followBtn.disabled = true
    try {
      await state.feed.append(createFollowEvent({ swarmId }))
      await state.feed.follow(swarmId)
      dom.followKeyEl.value = ''
      await state.feed.updateFollowers()
      await refreshUI()
    } catch (err) {
      alert('Error following: ' + err.message)
    }
    dom.followBtn.disabled = false
  })
}
