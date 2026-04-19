/**
 * Messages UI component - handles DM list and chat view
 */

import { state, dom } from '../state.js'
import { escapeHtml, safeAvatarUrl } from '../utils/dom.js'
import { formatTime, getDisplayName } from '../utils/format.js'
import { showToast } from './timeline.js'

// Refresh callback
let refreshUICallback = null

// Pending media for DM attachments
let dmPendingMedia = []

/**
 * Initialize messages component
 * @param {Function} refreshUI - Callback to refresh UI
 */
export function initMessages(refreshUI) {
  refreshUICallback = refreshUI

  // Messages nav button handler
  if (dom.messagesNavBtn) {
    dom.messagesNavBtn.addEventListener('click', () => {
      import('./panel.js').then(m => m.resetToPanel('messages'))
    })
  }

  // New message button
  if (dom.newMessageBtn) {
    dom.newMessageBtn.addEventListener('click', showNewMessagePicker)
  }

  // New message cancel
  if (dom.newMessageCancel) {
    dom.newMessageCancel.addEventListener('click', () => {
      dom.newMessageModal?.classList.add('hidden')
    })
  }

  // DM chat back button
  if (dom.dmChatBack) {
    dom.dmChatBack.addEventListener('click', hideDMChat)
  }

  // Send message button
  if (dom.dmSendBtn) {
    dom.dmSendBtn.addEventListener('click', sendCurrentMessage)
  }

  // Enter key to send (Shift+Enter for newline)
  if (dom.dmMessageInput) {
    dom.dmMessageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendCurrentMessage()
      }
    })
  }

  // Block button
  if (dom.dmBlockBtn) {
    dom.dmBlockBtn.addEventListener('click', toggleBlockUser)
  }

  // Mute button
  if (dom.dmMuteBtn) {
    dom.dmMuteBtn.addEventListener('click', toggleMuteUser)
  }

  // Set up DM update callback
  if (state.dm) {
    // Track last toast time per pubkey to avoid spam
    const lastToastTime = {}

    state.dm.onDataUpdate = async (pubkey) => {
      // Update unread counts and refresh list if in messages view
      updateUnreadBadge()
      if (state.currentPanel === 'messages') {
        renderMessagesList()
      }
      // If this conversation is open, refresh messages
      if (state.activeDMPubkey === pubkey) {
        renderChatMessages()
      } else {
        // Show toast notification for new message (if not viewing this conversation)
        // Rate limit: max one toast per conversation per 5 seconds
        const now = Date.now()
        const lastToast = lastToastTime[pubkey] || 0
        if (now - lastToast > 5000) {
          lastToastTime[pubkey] = now
          const displayName = getDisplayName(pubkey, state.identity, state.myProfile, state.peerProfiles)
          showToast('New Message', `${displayName} sent you a message`, 'info')
        }
      }
    }
  }

  // Initialize DM media handlers
  initDMMedia()
}

/**
 * Render the messages list in the right panel
 */
export async function renderMessagesList() {
  if (!dom.messagesList || !state.dm) {
    if (dom.messagesList) {
      dom.messagesList.innerHTML = '<div class="empty">DM not initialized</div>'
    }
    return
  }

  try {
    const conversations = await state.dm.getConversationList()

    if (conversations.length === 0) {
      dom.messagesList.innerHTML = `
        <div class="empty" style="padding: 40px 20px;">
          <div class="empty-icon">&#128172;</div>
          No messages yet<br>
          <span style="font-size: 0.85rem; color: #6e7681;">Click "New" to start a conversation</span>
        </div>
      `
      return
    }

    dom.messagesList.innerHTML = conversations.map(conv => {
      const displayName = getDisplayName(conv.pubkey, state.identity, state.myProfile, state.peerProfiles)
      const profile = state.peerProfiles[conv.pubkey]
      const initial = displayName.charAt(0).toUpperCase()
      const safeAv = safeAvatarUrl(profile?.avatar)
      const avatarContent = safeAv
        ? `<img src="${escapeHtml(safeAv)}" alt="avatar">`
        : escapeHtml(initial)
      const preview = conv.latestMessage || 'No messages yet'
      const time = conv.latestTimestamp ? formatTime(conv.latestTimestamp) : ''
      const unreadClass = conv.unreadCount > 0 ? 'has-unread' : ''

      return `
        <div class="message-item ${unreadClass}" data-pubkey="${escapeHtml(conv.pubkey || '')}">
          <div class="message-item-avatar">${avatarContent}</div>
          <div class="message-item-info">
            <div class="message-item-header">
              <span class="message-item-name">${escapeHtml(displayName)}</span>
              <span class="message-item-time">${time}</span>
            </div>
            <div class="message-item-preview">${escapeHtml(preview)}</div>
          </div>
          ${conv.unreadCount > 0 ? `<span class="message-item-unread">${conv.unreadCount}</span>` : ''}
        </div>
      `
    }).join('')

    // Add click handlers
    dom.messagesList.querySelectorAll('.message-item').forEach(item => {
      item.addEventListener('click', () => {
        const pubkey = item.dataset.pubkey
        showDMInCenter(pubkey)
      })
    })
  } catch (err) {
    console.error('Error rendering messages list:', err)
    dom.messagesList.innerHTML = '<div class="empty">Error loading messages</div>'
  }
}

/**
 * Show DM chat in center column
 * @param {string} otherPubkeyHex - Other user's pubkey
 */
export async function showDMInCenter(otherPubkeyHex) {
  if (!state.dm) {
    alert('DM system not initialized')
    return
  }

  state.activeDMPubkey = otherPubkeyHex

  // Get user info
  const displayName = getDisplayName(otherPubkeyHex, state.identity, state.myProfile, state.peerProfiles)
  const profile = state.peerProfiles[otherPubkeyHex]
  const initial = displayName.charAt(0).toUpperCase()

  // Check if we can DM this user (mutual follow required)
  const canDM = state.dm.canDM(otherPubkeyHex)

  // Update chat header
  if (dom.dmChatName) {
    dom.dmChatName.textContent = displayName
  }
  if (dom.dmChatAvatar) {
    const safeAv = safeAvatarUrl(profile?.avatar)
    dom.dmChatAvatar.innerHTML = safeAv
      ? `<img src="${escapeHtml(safeAv)}" alt="avatar">`
      : escapeHtml(initial)
  }

  // Update block/mute button states
  updateBlockMuteButtons()

  // Show chat view, hide timeline
  dom.dmChatView?.classList.remove('hidden')
  dom.postsEl?.classList.add('hidden')

  // Render messages
  await renderChatMessages()

  // Update input area based on mutual follow status
  updateChatInputState(canDM, displayName)

  // Mark as read
  await state.dm.markAsRead(otherPubkeyHex)
  await updateUnreadBadge()

  // Focus input if enabled
  if (canDM) {
    dom.dmMessageInput?.focus()
  }
}

/**
 * Update the chat input state based on mutual follow
 */
function updateChatInputState(canDM, displayName) {
  const inputArea = document.querySelector('.dm-chat-input')
  const statusHint = document.getElementById('dmMutualStatus')

  if (dom.dmMessageInput) {
    dom.dmMessageInput.disabled = !canDM
    dom.dmMessageInput.placeholder = canDM
      ? 'Type a message...'
      : 'Mutual follow required to send messages'
  }

  if (dom.dmSendBtn) {
    dom.dmSendBtn.disabled = !canDM
  }

  // Show/hide status hint
  if (statusHint) {
    if (!canDM) {
      statusHint.textContent = `Waiting for ${displayName} to follow you back`
      statusHint.classList.remove('hidden')
    } else {
      statusHint.classList.add('hidden')
    }
  }
}

/**
 * Hide DM chat and show timeline
 */
export function hideDMChat() {
  state.activeDMPubkey = null
  dom.dmChatView?.classList.add('hidden')
  dom.postsEl?.classList.remove('hidden')
}

/**
 * Render chat messages
 */
async function renderChatMessages() {
  if (!dom.dmChatMessages || !state.dm || !state.activeDMPubkey) return

  try {
    const messages = await state.dm.getMessages(state.activeDMPubkey)

    if (messages.length === 0) {
      dom.dmChatMessages.innerHTML = `
        <div class="dm-empty">
          <p>No messages yet</p>
          <p style="color: #6e7681; font-size: 0.85rem;">Send a message to start the conversation</p>
        </div>
      `
      return
    }

    dom.dmChatMessages.innerHTML = messages.map(msg => {
      const messageClass = msg.isMine ? 'dm-message sent' : 'dm-message received'
      const time = formatTime(msg.timestamp)

      let mediaHtml = ''
      if (msg.media && msg.media.length > 0) {
        mediaHtml = msg.media.map(m => {
          const dk = escapeHtml(m.driveKey || '')
          const pa = escapeHtml(m.path || '')
          const mi = escapeHtml(m.mimeType || '')
          if (m.type === 'file') {
            const filename = escapeHtml(m.filename || 'file')
            return `<div class="dm-message-file" data-drive-key="${dk}" data-path="${pa}" data-filename="${escapeHtml(m.filename || '')}">\u{1F4CE} ${filename}</div>`
          } else if (m.type === 'video' || (m.mimeType && m.mimeType.startsWith('video/'))) {
            return `<div class="dm-message-media" data-drive-key="${dk}" data-path="${pa}" data-mime="${mi}"></div>`
          } else if (m.mimeType && m.mimeType.startsWith('image/')) {
            return `<div class="dm-message-media" data-drive-key="${dk}" data-path="${pa}" data-mime="${mi}"></div>`
          }
          return ''
        }).join('')
      }

      return `
        <div class="${messageClass}">
          <div class="dm-message-content">${escapeHtml(msg.content)}</div>
          ${mediaHtml}
          <div class="dm-message-time">${time}</div>
        </div>
      `
    }).join('')

    // Load DM media
    for (const container of dom.dmChatMessages.querySelectorAll('.dm-message-media')) {
      const driveKey = container.dataset.driveKey
      const path = container.dataset.path
      const mime = container.dataset.mime
      if (state.media && driveKey && path) {
        state.media.getImageUrl(driveKey, path).then(url => {
          if (url) {
            if (mime?.startsWith('video/')) {
              container.innerHTML = `<video src="${url}" controls class="dm-media-video"></video>`
            } else {
              container.innerHTML = `<img src="${url}" class="dm-media-image" alt="attachment">`
            }
          }
        }).catch(err => console.warn('Error loading DM media:', err))
      }
    }
    // Load DM file download links
    for (const container of dom.dmChatMessages.querySelectorAll('.dm-message-file')) {
      const driveKey = container.dataset.driveKey
      const path = container.dataset.path
      const filename = container.dataset.filename
      if (state.media && driveKey && path) {
        state.media.getImageUrl(driveKey, path).then(url => {
          if (url) {
            container.innerHTML = `\u{1F4CE} <a href="${url}" download="${filename || 'file'}" class="dm-file-link">${escapeHtml(filename || 'Download file')}</a>`
          }
        }).catch(err => console.warn('Error loading DM file:', err))
      }
    }

    // Scroll to bottom
    dom.dmChatMessages.scrollTop = dom.dmChatMessages.scrollHeight
  } catch (err) {
    console.error('Error rendering chat messages:', err)
    dom.dmChatMessages.innerHTML = '<div class="dm-empty">Error loading messages</div>'
  }
}

/**
 * Send the current message
 */
async function sendCurrentMessage() {
  if (!dom.dmMessageInput || !state.dm || !state.activeDMPubkey) return

  const content = dom.dmMessageInput.value.trim()
  const pendingMedia = dmPendingMedia.slice()
  dmPendingMedia = []

  if (!content && pendingMedia.length === 0) return

  dom.dmSendBtn.disabled = true

  try {
    // Upload pending media
    const uploadedMedia = []
    if (state.media && pendingMedia.length > 0) {
      for (const file of pendingMedia) {
        let result
        if (file.type.startsWith('video/')) {
          result = await state.media.storeVideo(file, file.name)
        } else if (file.type.startsWith('image/')) {
          result = await state.media.storeImage(file, file.name)
        } else {
          result = await state.media.storeFile(file, file.name)
        }
        uploadedMedia.push(result)
      }
    }

    await state.dm.sendMessage(state.activeDMPubkey, content, uploadedMedia.length > 0 ? uploadedMedia : null)
    dom.dmMessageInput.value = ''

    // Clear media preview
    const previewEl = document.getElementById('dmMediaPreview')
    if (previewEl) previewEl.innerHTML = ''

    await renderChatMessages()
  } catch (err) {
    console.error('Error sending message:', err)
    alert('Failed to send message: ' + err.message)
  } finally {
    dom.dmSendBtn.disabled = false
  }
}

/**
 * Initialize DM media button and file input handlers
 */
function initDMMedia() {
  const dmMediaBtn = document.getElementById('dmMediaBtn')
  const dmMediaInput = document.getElementById('dmMediaInput')

  if (dmMediaBtn && dmMediaInput) {
    dmMediaBtn.addEventListener('click', () => {
      dmMediaInput.click()
    })

    dmMediaInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files)
      for (const file of files) {
        dmPendingMedia.push(file)
        addDMMediaPreview(file)
      }
      dmMediaInput.value = ''
    })
  }
}

/**
 * Add a preview item for a pending DM media file
 */
function addDMMediaPreview(file) {
  const previewEl = document.getElementById('dmMediaPreview')
  if (!previewEl) return

  const div = document.createElement('div')
  div.className = 'media-preview-item'

  const truncName = file.name.length > 20 ? file.name.slice(0, 20) + '...' : file.name

  if (file.type.startsWith('image/')) {
    const reader = new FileReader()
    reader.onload = (e) => {
      div.innerHTML = `
        <img src="${e.target.result}" alt="preview">
        <button class="remove-media" type="button">&times;</button>
      `
      div.querySelector('.remove-media').addEventListener('click', () => {
        const index = dmPendingMedia.indexOf(file)
        if (index > -1) dmPendingMedia.splice(index, 1)
        div.remove()
      })
      previewEl.appendChild(div)
    }
    reader.readAsDataURL(file)
  } else if (file.type.startsWith('video/')) {
    div.innerHTML = `
      <div class="video-preview-icon">&#127909;</div>
      <span class="file-preview-name">${truncName}</span>
      <button class="remove-media" type="button">&times;</button>
    `
    div.querySelector('.remove-media').addEventListener('click', () => {
      const index = dmPendingMedia.indexOf(file)
      if (index > -1) dmPendingMedia.splice(index, 1)
      div.remove()
    })
    previewEl.appendChild(div)
  } else {
    div.innerHTML = `
      <span class="file-preview-name">${truncName}</span>
      <button class="remove-media" type="button">&times;</button>
    `
    div.querySelector('.remove-media').addEventListener('click', () => {
      const index = dmPendingMedia.indexOf(file)
      if (index > -1) dmPendingMedia.splice(index, 1)
      div.remove()
    })
    previewEl.appendChild(div)
  }
}

/**
 * Update the unread badge in nav
 */
export async function updateUnreadBadge() {
  if (!dom.messagesBadge || !state.dm) return

  try {
    const total = await state.dm.getTotalUnreadCount()

    if (total > 0) {
      dom.messagesBadge.textContent = total > 99 ? '99+' : total
      dom.messagesBadge.classList.remove('hidden')
    } else {
      dom.messagesBadge.classList.add('hidden')
    }
  } catch (err) {
    console.error('Error updating unread badge:', err)
  }
}

/**
 * Show new message picker modal
 */
export function showNewMessagePicker() {
  if (!dom.newMessageModal || !dom.newMessageUserList || !state.dm) return

  // Get messagable users from peer profiles
  const users = state.dm.getMessagableUsers(state.peerProfiles)

  if (users.length === 0) {
    dom.newMessageUserList.innerHTML = `
      <div class="empty" style="padding: 20px;">
        No followed users yet.<br>
        <span style="font-size: 0.85rem; color: #6e7681;">Follow someone who follows you back to enable DMs.</span>
      </div>
    `
  } else {
    dom.newMessageUserList.innerHTML = users.map(user => {
      const initial = user.name.charAt(0).toUpperCase()
      const safeAv = safeAvatarUrl(user.avatar)
      const avatarContent = safeAv
        ? `<img src="${escapeHtml(safeAv)}" alt="avatar">`
        : escapeHtml(initial)

      // Check if this is a mutual follow
      const canDM = state.dm.canDM(user.pubkey)
      const statusClass = canDM ? 'mutual' : 'not-mutual'
      const statusHint = canDM ? '' : 'title="Waiting for them to follow you back"'
      const disabledClass = canDM ? '' : 'disabled'

      return `
        <div class="new-message-user ${disabledClass}" data-pubkey="${escapeHtml(user.pubkey || '')}" data-can-dm="${canDM}" ${statusHint}>
          <div class="new-message-avatar">${avatarContent}</div>
          <span class="new-message-name">${escapeHtml(user.name)}</span>
          ${!canDM ? '<span class="dm-status-hint">Waiting for follow back</span>' : ''}
        </div>
      `
    }).join('')

    // Add click handlers only for mutual follows
    dom.newMessageUserList.querySelectorAll('.new-message-user').forEach(item => {
      item.addEventListener('click', () => {
        const pubkey = item.dataset.pubkey
        const canDM = item.dataset.canDm === 'true'

        if (!canDM) {
          alert('You can only message users who follow you back.')
          return
        }

        dom.newMessageModal.classList.add('hidden')
        showDMInCenter(pubkey)
      })
    })
  }

  dom.newMessageModal.classList.remove('hidden')
}

/**
 * Update block/mute button states
 */
function updateBlockMuteButtons() {
  if (!state.dm || !state.activeDMPubkey) return

  const isBlocked = state.dm.isBlocked(state.activeDMPubkey)
  const isMuted = state.dm.isMuted(state.activeDMPubkey)

  if (dom.dmBlockBtn) {
    dom.dmBlockBtn.textContent = isBlocked ? 'Unblock' : 'Block'
    dom.dmBlockBtn.classList.toggle('active', isBlocked)
  }

  if (dom.dmMuteBtn) {
    dom.dmMuteBtn.textContent = isMuted ? 'Unmute' : 'Mute'
    dom.dmMuteBtn.classList.toggle('active', isMuted)
  }
}

/**
 * Toggle block user
 */
async function toggleBlockUser() {
  if (!state.dm || !state.activeDMPubkey) return

  try {
    if (state.dm.isBlocked(state.activeDMPubkey)) {
      await state.dm.unblockUser(state.activeDMPubkey)
    } else {
      if (confirm('Block this user? You won\'t receive messages from them.')) {
        await state.dm.blockUser(state.activeDMPubkey)
        hideDMChat()
        if (state.currentPanel === 'messages') {
          renderMessagesList()
        }
      }
    }
    updateBlockMuteButtons()
  } catch (err) {
    console.error('Error toggling block:', err)
    alert('Failed to update block status')
  }
}

/**
 * Toggle mute user
 */
async function toggleMuteUser() {
  if (!state.dm || !state.activeDMPubkey) return

  try {
    if (state.dm.isMuted(state.activeDMPubkey)) {
      await state.dm.unmuteUser(state.activeDMPubkey)
    } else {
      await state.dm.muteUser(state.activeDMPubkey)
    }
    updateBlockMuteButtons()
  } catch (err) {
    console.error('Error toggling mute:', err)
    alert('Failed to update mute status')
  }
}

/**
 * Add "Message" button to a profile view
 * @param {HTMLElement} container - Container to add button to
 * @param {string} pubkeyHex - User's pubkey
 */
export function addMessageButtonToProfile(container, pubkeyHex) {
  if (!state.dm || pubkeyHex === state.identity?.pubkeyHex) return

  const btn = document.createElement('button')
  btn.className = 'profile-message-btn'
  btn.textContent = 'Message'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    showDMInCenter(pubkeyHex)
  })

  container.appendChild(btn)
}
