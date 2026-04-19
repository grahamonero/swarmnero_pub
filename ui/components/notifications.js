/**
 * Notifications component - pending reply approvals
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { formatTime, getDisplayName } from '../utils/format.js'
import { createReplyMetadataEvent } from '../../lib/events.js'

let refreshUICallback = null

/**
 * Initialize notifications component
 */
export function initNotifications(refreshUI) {
  refreshUICallback = refreshUI

  // Nav button click handler
  const notifNavBtn = document.getElementById('notificationsNavBtn')
  if (notifNavBtn) {
    notifNavBtn.addEventListener('click', () => {
      showNotificationsPanel()
    })
  }
}

/**
 * Update the notifications badge count
 */
export function updateNotificationsBadge() {
  const badge = document.getElementById('notificationsBadge')
  if (!badge) return

  const replyCount = state.replyNotify?.getPendingApprovals()?.length || 0
  const tipCount = (state.tipNotifications || []).filter(t => !t.dismissed).length
  const count = replyCount + tipCount

  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count
    badge.classList.remove('hidden')
  } else {
    badge.classList.add('hidden')
  }
}

/**
 * Show the notifications panel in the right panel
 */
export async function showNotificationsPanel() {
  const { showSection } = await import('./panel.js')
  showSection('notifications')
  renderNotifications()
}

/**
 * Render notifications list
 */
export function renderNotifications() {
  const container = document.getElementById('notificationsContent')
  if (!container) return

  const pending = state.replyNotify?.getPendingApprovals() || []
  const tips = (state.tipNotifications || []).filter(t => !t.dismissed)

  if (pending.length === 0 && tips.length === 0) {
    container.innerHTML = `
      <div class="empty-notifications">
        <div class="empty-icon">&#128276;</div>
        <p>No pending notifications</p>
        <p class="empty-hint">Reply approval requests and incoming tips will appear here.</p>
      </div>
    `
    return
  }

  // Render tip notifications
  const tipNotificationsHtml = tips.map(tip => {
    const receivedTime = formatTime(tip.receivedAt)
    const safeId = escapeHtml(tip.id || '')
    return `
      <div class="notification-item notification-tip" data-id="${safeId}">
        <div class="notification-header">
          <span class="notification-icon">💰</span>
          <span class="notification-label">You received a tip!</span>
          <span class="notification-time">${receivedTime}</span>
        </div>
        <div class="notification-preview tip-amount">${escapeHtml(String(tip.amount))} XMR</div>
        <div class="notification-actions">
          <button class="dismiss-tip-btn" data-id="${safeId}">Dismiss</button>
        </div>
      </div>
    `
  }).join('')

  // Render reply notifications
  const replyNotificationsHtml = pending.map(notif => {
    const authorName = notif.author?.name || notif.reply.pubkey.slice(0, 8) + '...'
    const content = notif.reply.content || ''
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content
    const receivedTime = formatTime(notif.receivedAt)

    const safeId = escapeHtml(notif.id || '')
    const safeRPk = escapeHtml(notif.reply.pubkey || '')
    return `
      <div class="notification-item" data-id="${safeId}">
        <div class="notification-header">
          <span class="notification-author">@${escapeHtml(authorName)}</span>
          <span class="notification-label">replied to your post</span>
          <span class="notification-time">${receivedTime}</span>
        </div>
        <div class="notification-preview">${escapeHtml(preview)}</div>
        <div class="notification-actions">
          <button class="approve-btn" data-id="${safeId}">Approve</button>
          <button class="ignore-btn" data-id="${safeId}">Ignore</button>
          <button class="mute-btn" data-id="${safeId}" data-pubkey="${safeRPk}">Mute User</button>
        </div>
      </div>
    `
  }).join('')

  container.innerHTML = `
    <div class="notifications-list">
      ${tipNotificationsHtml}
      ${replyNotificationsHtml}
    </div>
  `

  // Add tip dismiss handlers
  container.querySelectorAll('.dismiss-tip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      const tip = state.tipNotifications.find(t => t.id === id)
      if (tip) tip.dismissed = true
      updateNotificationsBadge()
      renderNotifications()
    })
  })

  // Add reply click handlers
  container.querySelectorAll('.approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await handleApprove(btn.dataset.id)
    })
  })

  container.querySelectorAll('.ignore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await handleIgnore(btn.dataset.id)
    })
  })

  container.querySelectorAll('.mute-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await handleMute(btn.dataset.id, btn.dataset.pubkey)
    })
  })
}

/**
 * Handle approve action
 */
async function handleApprove(id) {
  if (!state.replyNotify || !state.feed) return

  try {
    // Get the reply data before approving
    const pending = state.replyNotify.getPendingApprovals().find(p => p.id === id)
    if (!pending) return

    // Approve in the protocol (stores locally, sends ACK)
    const result = await state.replyNotify.approveReply(id)
    if (!result) return

    // Append reply_metadata to our feed so followers can see who replied
    await state.feed.append(createReplyMetadataEvent({
      postTimestamp: result.postTimestamp,
      replier: {
        pubkey: result.replier.pubkey,
        swarmId: result.replier.swarmId,
        name: result.replier.name,
        replyTimestamp: result.replier.replyTimestamp
      }
    }))

    console.log('[Notifications] Approved reply and appended metadata')

    // Auto-follow the replier so we can see their reply
    const replierSwarmId = result.replier.swarmId
    if (replierSwarmId && !state.feed.peers?.has(replierSwarmId)) {
      console.log('[Notifications] Auto-following replier:', replierSwarmId)
      const { createFollowEvent } = await import('../../lib/events.js')
      await state.feed.append(createFollowEvent({ swarmId: replierSwarmId }))
      await state.feed.follow(replierSwarmId)
    }

    // Update UI
    updateNotificationsBadge()
    renderNotifications()
    if (refreshUICallback) refreshUICallback()

  } catch (err) {
    console.error('[Notifications] Error approving:', err)
    alert('Error approving reply: ' + err.message)
  }
}

/**
 * Handle ignore action
 */
async function handleIgnore(id) {
  if (!state.replyNotify) return

  try {
    state.replyNotify.ignoreReply(id)

    // Update UI
    updateNotificationsBadge()
    renderNotifications()

  } catch (err) {
    console.error('[Notifications] Error ignoring:', err)
  }
}

/**
 * Handle mute action
 */
async function handleMute(id, pubkey) {
  if (!state.replyNotify) return

  if (!confirm('Mute this user? You won\'t receive any more notifications from them.')) {
    return
  }

  try {
    state.replyNotify.muteUser(pubkey)

    // Update UI
    updateNotificationsBadge()
    renderNotifications()

  } catch (err) {
    console.error('[Notifications] Error muting:', err)
  }
}

/**
 * Get pending notifications count (for external use)
 */
export function getPendingCount() {
  return state.replyNotify?.getPendingApprovals()?.length || 0
}
