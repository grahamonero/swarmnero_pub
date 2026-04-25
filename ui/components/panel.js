/**
 * Right panel component - manages all right panel sections
 * Implements a navigation stack for proper back navigation
 */

import { state, dom } from '../state.js'
import { escapeHtml, wrapSelection, insertAtCursor, parseSwarmId, safeAvatarUrl, safeWebsiteUrl } from '../utils/dom.js'
import { formatTime, getDisplayName, renderMarkdown, formatFileSize, getOnlineDotHtml } from '../utils/format.js'
import { initEmojiPicker, toggleEmojiPicker } from '../utils/emoji.js'
import {
  buildThread,
  getInteractionCounts,
  hasReposted,
  createReplyEvent,
  createReactionEvent,
  getUserReaction,
  isValidReactionEmoji,
  createRepostEvent,
  createFollowEvent,
  createUnfollowEvent
} from '../../lib/events.js'
import { emojis as EMOJI_PICKER_LIST } from '../utils/emoji.js'
import * as wallet from '../../lib/wallet.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'
import { savePeerProfilesDebounced } from '../../lib/peer-profile-cache.js'

// Persist the current peerProfiles map for the active account. Called after
// FoF-sourced profiles fill in unknown followers/following entries.
function persistDiscoveredProfile() {
  const dataDir = (typeof Pear !== 'undefined' && Pear.config?.storage) || null
  if (!dataDir || !state.identity?.pubkeyHex) return
  savePeerProfilesDebounced(dataDir, state.identity.pubkeyHex, state.peerProfiles)
}

// Thread reply state
let threadPendingMedia = []
let threadPendingFiles = []

/**
 * Get the count of followers for a user
 * For own profile: uses feed.followers Set (populated via FoF announcements)
 * For others: counts users whose following list includes their swarmId
 */
export function getFollowersCount(pubkey) {
  if (!state.feed) return 0

  // For our own profile, use the followers Set directly
  // This includes followers who don't follow us back (via FoF announcements)
  if (pubkey === state.feed.identity?.pubkeyHex) {
    return state.feed.followers?.size || 0
  }

  // For other users, use the old logic (scan known users' following lists)
  let count = 0
  for (const [swarmId, pk] of Object.entries(state.swarmIdToPubkey || {})) {
    if (pk === pubkey) {
      for (const [followerSwarmId, followerPubkey] of Object.entries(state.swarmIdToPubkey || {})) {
        if (followerSwarmId !== swarmId) {
          const followerFollowing = getFollowingForPubkey(followerPubkey)
          if (followerFollowing.includes(swarmId)) {
            count++
          }
        }
      }
      break
    }
  }

  return count
}

/**
 * Get followers list for a user (swarm IDs of people who follow them)
 * For own profile: uses feed.followers Set (populated via FoF announcements)
 * For others: scans known users' following lists
 */
function getFollowersList(pubkey) {
  if (!state.feed) return []

  // For our own profile, use the followers Set directly
  if (pubkey === state.feed.identity?.pubkeyHex) {
    const followers = []
    for (const swarmId of state.feed.followers || []) {
      // Try to find pubkey for this swarmId
      const followerPubkey = state.swarmIdToPubkey?.[swarmId] || null
      followers.push({
        swarmId,
        pubkey: followerPubkey
      })
    }
    return followers
  }

  // For other users, use the old logic
  const followers = []
  let targetSwarmId = null

  for (const [swarmId, pk] of Object.entries(state.swarmIdToPubkey || {})) {
    if (pk === pubkey) {
      targetSwarmId = swarmId
      break
    }
  }

  if (!targetSwarmId) return []

  for (const [followerSwarmId, followerPubkey] of Object.entries(state.swarmIdToPubkey || {})) {
    if (followerSwarmId !== targetSwarmId) {
      const followerFollowing = getFollowingForPubkey(followerPubkey)
      if (followerFollowing.includes(targetSwarmId)) {
        followers.push({
          swarmId: followerSwarmId,
          pubkey: followerPubkey
        })
      }
    }
  }

  return followers
}

/**
 * Get the following list for a specific pubkey
 * For self, use feed.getFollowing(), for others scan timeline for follow events
 */
export function getFollowingForPubkey(pubkey) {
  if (pubkey === state.identity?.pubkeyHex) {
    return state.feed?.getFollowing() || []
  }

  // For other users, scan timeline for their follow/unfollow events
  const timeline = state.currentTimeline || []
  const followedSet = new Set()

  // Get all follow/unfollow events from this user, sorted by timestamp
  const followEvents = timeline
    .filter(e => (e.type === 'follow' || e.type === 'unfollow') && e.pubkey === pubkey)
    .sort((a, b) => a.timestamp - b.timestamp)

  for (const event of followEvents) {
    if (event.type === 'follow' && event.swarm_id) {
      followedSet.add(event.swarm_id)
    } else if (event.type === 'unfollow' && event.swarm_id) {
      followedSet.delete(event.swarm_id)
    }
  }

  return Array.from(followedSet)
}

/**
 * Get following list with profile info for display
 */
function getFollowingWithProfiles(pubkey) {
  const following = []
  const followingSwarmIds = getFollowingForPubkey(pubkey)

  for (const swarmId of followingSwarmIds) {
    const pk = state.swarmIdToPubkey?.[swarmId]
    const profile = pk ? state.peerProfiles?.[pk] : null
    following.push({
      swarmId,
      pubkey: pk,
      profile
    })
  }

  return following
}

/**
 * Show modal with list of users this profile follows
 */
export function showFollowingModal(pubkey, overrideList = null) {
  const following = overrideList || getFollowingWithProfiles(pubkey)
  const isMe = !overrideList && pubkey === state.identity?.pubkeyHex

  const existingModal = document.getElementById('followModal')
  if (existingModal) existingModal.remove()

  const modal = document.createElement('div')
  modal.id = 'followModal'
  modal.className = 'follow-modal-overlay'

  const listHtml = following.length === 0
    ? '<div class="follow-modal-empty">Not following anyone yet</div>'
    : following.map(f => {
        const name = f.pubkey
          ? getDisplayName(f.pubkey, state.identity, state.myProfile, state.peerProfiles)
          : (f.name || (f.swarmId?.slice(0, 12) + '...'))
        const avatar = f.profile?.avatar || (f.pubkey ? state.peerProfiles?.[f.pubkey]?.avatar : null)
        const safeAvatarF = safeAvatarUrl(avatar)
        const initial = name.charAt(0).toUpperCase()
        const avatarHtml = safeAvatarF
          ? `<div class="follow-modal-avatar"><img src="${escapeHtml(safeAvatarF)}" alt=""></div>`
          : `<div class="follow-modal-avatar">${escapeHtml(initial)}</div>`
        const unfollowBtn = isMe && f.swarmId
          ? `<button class="follow-modal-unfollow" data-swarm-id="${escapeHtml(f.swarmId)}">Unfollow</button>`
          : ''

        return `
          <div class="follow-modal-item" data-pubkey="${escapeHtml(f.pubkey || '')}" data-swarm-id="${escapeHtml(f.swarmId || '')}">
            ${avatarHtml}
            <span class="follow-modal-name">${escapeHtml(name)}</span>${getOnlineDotHtml(f.pubkey)}
            ${unfollowBtn}
          </div>
        `
      }).join('')

  const followInputHtml = isMe ? `
    <div class="follow-modal-input">
      <input type="text" id="followModalInput" placeholder="Paste Swarm ID to follow...">
      <button id="followModalBtn">Follow</button>
    </div>
  ` : ''

  modal.innerHTML = `
    <div class="follow-modal">
      <div class="follow-modal-header">
        <h3>Following</h3>
        <button class="follow-modal-close">&times;</button>
      </div>
      ${followInputHtml}
      <div class="follow-modal-list">
        ${listHtml}
      </div>
    </div>
  `

  document.body.appendChild(modal)

  modal.querySelector('.follow-modal-close').addEventListener('click', () => {
    modal.remove()
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove()
    }
  })

  modal.querySelectorAll('.follow-modal-item').forEach(item => {
    item.style.cursor = 'pointer'
    item.addEventListener('click', async (e) => {
      // Don't navigate if clicking unfollow button
      if (e.target.classList.contains('follow-modal-unfollow')) return
      const itemPubkey = item.dataset.pubkey
      const itemSwarmId = item.dataset.swarmId
      if (itemPubkey) {
        modal.remove()
        await pushPanel('profile', { pubkey: itemPubkey, timeline: state.currentTimeline })
      } else if (itemSwarmId) {
        // No pubkey available — open minimal profile in center column
        modal.remove()
        const { showProfileInCenter } = await import('./timeline.js')
        await showProfileInCenter({
          name: null,
          bio: null,
          avatar: null,
          website: null,
          swarmId: itemSwarmId
        })
      }
    })
  })

  // Unfollow button handlers
  modal.querySelectorAll('.follow-modal-unfollow').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const swarmId = btn.dataset.swarmId
      if (!swarmId) return

      btn.disabled = true
      btn.textContent = '...'
      try {
        await state.feed.append(createUnfollowEvent({ swarmId }))
        await state.feed.unfollow(swarmId)
        // Remove the item from the list
        btn.closest('.follow-modal-item')?.remove()
        // If list is now empty, show empty message
        const list = modal.querySelector('.follow-modal-list')
        if (list && !list.querySelector('.follow-modal-item')) {
          list.innerHTML = '<div class="follow-modal-empty">Not following anyone yet</div>'
        }
        // Update follower tracking and refresh UI
        await state.feed.updateFollowers()
        if (refreshUICallback) await refreshUICallback()
      } catch (err) {
        alert('Error unfollowing: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Unfollow'
      }
    })
  })

  // Follow button handler (only present when viewing own following)
  const followBtn = modal.querySelector('#followModalBtn')
  const followInput = modal.querySelector('#followModalInput')
  if (followBtn && followInput) {
    followBtn.addEventListener('click', async () => {
      const input = followInput.value.trim()
      if (!input) return

      const swarmId = parseSwarmId(input)
      if (!swarmId) {
        alert('Invalid Swarm ID. Paste a valid 64-character hex ID.')
        return
      }

      followBtn.disabled = true
      followBtn.textContent = '...'
      try {
        await state.feed.append(createFollowEvent({ swarmId }))
        await state.feed.follow(swarmId)
        followInput.value = ''
        // Update follower tracking and refresh UI
        await state.feed.updateFollowers()
        if (refreshUICallback) await refreshUICallback()
        // Close modal and reopen to show updated list
        modal.remove()
        showFollowingModal(pubkey)
      } catch (err) {
        alert('Error following: ' + err.message)
      } finally {
        followBtn.disabled = false
        followBtn.textContent = 'Follow'
      }
    })
  }

  // Request profiles for unknown swarmIds from connected peers
  const unknownSwarmIds = following
    .filter(f => !f.pubkey && f.swarmId)
    .map(f => f.swarmId)

  if (unknownSwarmIds.length > 0 && state.fof) {
    state.fof.requestProfiles(unknownSwarmIds).then(profiles => {
      if (!profiles || Object.keys(profiles).length === 0) return

      for (const [swarmId, profile] of Object.entries(profiles)) {
        if (!/^[a-f0-9]{64}$/i.test(swarmId)) continue
        const item = modal.querySelector(`.follow-modal-item[data-swarm-id="${swarmId}"]`)
        if (item && profile.name) {
          const nameEl = item.querySelector('.follow-modal-name')
          if (nameEl) nameEl.textContent = profile.name
          if (profile.pubkey) item.dataset.pubkey = profile.pubkey

          const avatarEl = item.querySelector('.follow-modal-avatar')
          const safeAv = safeAvatarUrl(profile.avatar)
          if (avatarEl && safeAv) {
            avatarEl.innerHTML = `<img src="${escapeHtml(safeAv)}" alt="">`
          } else if (avatarEl && profile.name) {
            avatarEl.textContent = profile.name.charAt(0).toUpperCase()
          }

          if (profile.pubkey && state.swarmIdToPubkey && /^[a-f0-9]{64}$/i.test(swarmId) && /^[a-f0-9]{64}$/i.test(profile.pubkey)) {
            state.swarmIdToPubkey[swarmId] = profile.pubkey
          }
          if (profile.pubkey && state.peerProfiles && /^[a-f0-9]{64}$/i.test(profile.pubkey) && !state.peerProfiles[profile.pubkey]) {
            state.peerProfiles[profile.pubkey] = {
              name: profile.name, bio: profile.bio,
              avatar: profile.avatar, website: profile.website
            }
            persistDiscoveredProfile()
          }
        }
      }
    })
  }
}

/**
 * Show modal with list of users who follow this profile
 */
export function showFollowersModal(pubkey, overrideList = null) {
  const followers = overrideList || getFollowersList(pubkey)

  const existingModal = document.getElementById('followModal')
  if (existingModal) existingModal.remove()

  const modal = document.createElement('div')
  modal.id = 'followModal'
  modal.className = 'follow-modal-overlay'

  const listHtml = followers.length === 0
    ? '<div class="follow-modal-empty">No followers yet</div>'
    : followers.map(f => {
        const name = f.pubkey
          ? getDisplayName(f.pubkey, state.identity, state.myProfile, state.peerProfiles)
          : (f.name || (f.swarmId?.slice(0, 12) + '...'))
        const profile = state.peerProfiles?.[f.pubkey]
        const safeAv = safeAvatarUrl(profile?.avatar)
        const initial = name.charAt(0).toUpperCase()
        const avatarHtml = safeAv
          ? `<div class="follow-modal-avatar"><img src="${escapeHtml(safeAv)}" alt=""></div>`
          : `<div class="follow-modal-avatar">${escapeHtml(initial)}</div>`

        return `
          <div class="follow-modal-item" data-pubkey="${escapeHtml(f.pubkey || '')}" data-swarm-id="${escapeHtml(f.swarmId || '')}">
            ${avatarHtml}
            <span class="follow-modal-name">${escapeHtml(name)}</span>${getOnlineDotHtml(f.pubkey)}
          </div>
        `
      }).join('')

  modal.innerHTML = `
    <div class="follow-modal">
      <div class="follow-modal-header">
        <h3>Followers</h3>
        <button class="follow-modal-close">&times;</button>
      </div>
      <div class="follow-modal-list">
        ${listHtml}
      </div>
    </div>
  `

  document.body.appendChild(modal)

  modal.querySelector('.follow-modal-close').addEventListener('click', () => {
    modal.remove()
  })

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove()
    }
  })

  modal.querySelectorAll('.follow-modal-item').forEach(item => {
    item.style.cursor = 'pointer'
    item.addEventListener('click', async () => {
      const itemPubkey = item.dataset.pubkey
      const itemSwarmId = item.dataset.swarmId
      if (itemPubkey) {
        modal.remove()
        await pushPanel('profile', { pubkey: itemPubkey, timeline: state.currentTimeline })
      } else if (itemSwarmId) {
        modal.remove()
        const { showProfileInCenter } = await import('./timeline.js')
        await showProfileInCenter({
          name: null,
          bio: null,
          avatar: null,
          website: null,
          swarmId: itemSwarmId
        })
      }
    })
  })

  // Request profiles for unknown swarmIds from connected peers
  const unknownSwarmIds = followers
    .filter(f => !f.pubkey && f.swarmId)
    .map(f => f.swarmId)

  if (unknownSwarmIds.length > 0 && state.fof) {
    state.fof.requestProfiles(unknownSwarmIds).then(profiles => {
      if (!profiles || Object.keys(profiles).length === 0) return

      for (const [swarmId, profile] of Object.entries(profiles)) {
        if (!/^[a-f0-9]{64}$/i.test(swarmId)) continue
        const item = modal.querySelector(`.follow-modal-item[data-swarm-id="${swarmId}"]`)
        if (item && profile.name) {
          const nameEl = item.querySelector('.follow-modal-name')
          if (nameEl) nameEl.textContent = profile.name
          if (profile.pubkey) item.dataset.pubkey = profile.pubkey

          const avatarEl = item.querySelector('.follow-modal-avatar')
          const safeAv = safeAvatarUrl(profile.avatar)
          if (avatarEl && safeAv) {
            avatarEl.innerHTML = `<img src="${escapeHtml(safeAv)}" alt="">`
          } else if (avatarEl && profile.name) {
            avatarEl.textContent = profile.name.charAt(0).toUpperCase()
          }

          if (profile.pubkey && state.swarmIdToPubkey && /^[a-f0-9]{64}$/i.test(swarmId) && /^[a-f0-9]{64}$/i.test(profile.pubkey)) {
            state.swarmIdToPubkey[swarmId] = profile.pubkey
          }
          if (profile.pubkey && state.peerProfiles && /^[a-f0-9]{64}$/i.test(profile.pubkey) && !state.peerProfiles[profile.pubkey]) {
            state.peerProfiles[profile.pubkey] = {
              name: profile.name, bio: profile.bio,
              avatar: profile.avatar, website: profile.website
            }
            persistDiscoveredProfile()
          }
        }
      }
    })
  }
}

// Callback for rendering wallet panel (set by wallet.js)
let renderWalletCallback = null

/**
 * Set the render wallet callback
 */
export function setRenderWalletCallback(callback) {
  renderWalletCallback = callback
}

/**
 * Hide ALL panel sections (for showPanelView)
 */
function hideAllPanelSections() {
  dom.panelEmpty?.classList.add('hidden')
  dom.profileSection?.classList.add('hidden')
  dom.followSection?.classList.add('hidden')
  dom.discoverySection?.classList.add('hidden')
  dom.aboutSection?.classList.add('hidden')
  dom.userProfileSection?.classList.add('hidden')
  dom.accountsSection?.classList.add('hidden')
  dom.walletSection?.classList.add('hidden')
  dom.messagesSection?.classList.add('hidden')
  document.getElementById('notifications-section')?.classList.add('hidden')
  dom.searchSection?.classList.add('hidden')
  dom.trendingSection?.classList.add('hidden')
  dom.settingsSection?.classList.add('hidden')
  dom.storageSection?.classList.add('hidden')
}

/**
 * Hide all panel sections and show empty state (Swarm ID)
 * Also resets the navigation stack
 */
export function hideAllSections() {
  hideAllPanelSections()
  dom.postsEl?.classList.remove('hidden')  // Restore posts view
  dom.panelEmpty?.classList.remove('hidden')

  // Remove active state from nav buttons
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))

  state.selectedProfile = null
  state.selectedThread = null
  state.currentPanel = 'swarm-id'
  state.panelStack = []
}

/**
 * Show a specific panel view, hiding all others
 * This is the core function that ensures only one panel is visible at a time
 * @param {string} type - Panel type: 'swarm-id', 'wallet', 'profile', 'thread', 'follow', 'about', 'accounts', 'profile-settings'
 * @param {object} data - Optional data for the panel (e.g., pubkey for profile, pubkey+timestamp for thread)
 */
export async function showPanelView(type, data = {}) {
  // Hide all sections first
  hideAllPanelSections()

  // Remove active state from nav buttons
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))

  // Update current panel state
  state.currentPanel = type

  // Show the requested panel
  switch (type) {
    case 'swarm-id':
      dom.postsEl?.classList.remove('hidden')  // Restore posts view
      dom.panelEmpty?.classList.remove('hidden')
      state.selectedProfile = null
      state.selectedThread = null
      break

    case 'wallet':
      dom.walletSection?.classList.remove('hidden')
      if (renderWalletCallback) {
        await renderWalletCallback()
      }
      break

    case 'profile':
      // Show another user's profile
      if (data.pubkey) {
        state.selectedProfile = data.pubkey
        state.selectedThread = null
        dom.userProfileSection?.classList.remove('hidden')
        await showProfile(data.pubkey, data.timeline || state.currentTimeline)
      }
      break

    case 'thread':
      // Show thread view
      if (data.pubkey && data.timestamp) {
        state.selectedThread = { pubkey: data.pubkey, timestamp: data.timestamp }
        state.selectedProfile = null
        dom.userProfileSection?.classList.remove('hidden')
        await showThread(data.pubkey, data.timestamp, data.focusReply || false)
      }
      break

    case 'profile-settings':
      dom.profileSection?.classList.remove('hidden')
      // Set active state for profile nav button
      document.querySelector('.nav-btn[data-view="profile"]')?.classList.add('active')
      // Refresh the sync section so it reflects any toggle made in Settings
      import('./profile.js').then(m => {
        m.renderProfileSyncSection?.()
        m.renderProfileRenewalBanner?.()
      })
      break

    case 'follow':
      dom.followSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="follow"]')?.classList.add('active')
      break

    case 'discovery':
      dom.postsEl?.classList.add('hidden')
      dom.discoverySection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="discovery"]')?.classList.add('active')
      // Import and render discovery list
      import('./discovery.js').then(m => m.renderDiscovery())
      break

    case 'about':
      dom.aboutSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="about"]')?.classList.add('active')
      break

    case 'accounts':
      dom.accountsSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="accounts"]')?.classList.add('active')
      // Import and render accounts panel
      import('./accounts.js').then(m => m.renderAccountsPanel())
      break

    case 'messages':
      dom.messagesSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="messages"]')?.classList.add('active')
      // Import and render messages list
      import('./messages.js').then(m => m.renderMessagesList())
      break

    case 'notifications':
      document.getElementById('notifications-section')?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="notifications"]')?.classList.add('active')
      // Import and render notifications
      import('./notifications.js').then(m => m.renderNotifications())
      break

    case 'search':
      dom.postsEl?.classList.add('hidden')
      dom.searchSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="search"]')?.classList.add('active')
      // Import and render search
      import('./search.js').then(m => m.renderSearch())
      break

    case 'trending':
      dom.postsEl?.classList.add('hidden')
      dom.trendingSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="trending"]')?.classList.add('active')
      // Import and render trending
      import('./trending.js').then(m => m.renderTrending())
      break

    case 'settings':
      dom.postsEl?.classList.add('hidden')
      dom.settingsSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="settings"]')?.classList.add('active')
      // Import and render settings
      import('./settings.js').then(m => m.renderSettings())
      break

    case 'storage':
      dom.postsEl?.classList.add('hidden')
      dom.storageSection?.classList.remove('hidden')
      document.querySelector('.nav-btn[data-view="storage"]')?.classList.add('active')
      import('./storage.js').then(m => m.renderStorage())
      break

    default:
      // Default to Swarm ID - restore posts view
      dom.postsEl?.classList.remove('hidden')
      dom.panelEmpty?.classList.remove('hidden')
      state.currentPanel = 'swarm-id'
  }
}

/**
 * Push a new panel onto the navigation stack and show it
 * @param {string} type - Panel type
 * @param {object} data - Optional data for the panel
 */
export async function pushPanel(type, data = {}) {
  // Save current panel to stack (if not already on the target panel)
  if (state.currentPanel !== type) {
    // Build the data for the current panel to save
    const currentData = {}
    if (state.currentPanel === 'profile' && state.selectedProfile) {
      currentData.pubkey = state.selectedProfile
    } else if (state.currentPanel === 'thread' && state.selectedThread) {
      currentData.pubkey = state.selectedThread.pubkey
      currentData.timestamp = state.selectedThread.timestamp
    }

    state.panelStack.push({
      type: state.currentPanel,
      data: currentData
    })
  }

  // Show the new panel
  await showPanelView(type, data)
}

/**
 * Pop the navigation stack and return to the previous panel
 * If stack is empty, returns to Swarm ID (default)
 */
export async function popPanel() {
  if (state.panelStack.length > 0) {
    const prev = state.panelStack.pop()
    await showPanelView(prev.type, prev.data)
  } else {
    // Stack is empty, go to default (Swarm ID)
    await showPanelView('swarm-id')
  }
}

/**
 * Clear the navigation stack and go to a specific panel
 * Use this when you want to reset navigation (e.g., nav button clicks)
 * @param {string} type - Panel type
 * @param {object} data - Optional data for the panel
 */
export async function resetToPanel(type, data = {}) {
  state.panelStack = []
  await showPanelView(type, data)
}

/**
 * Show a specific panel section (legacy function - wraps showPanelView)
 * Maps old section names to new panel types
 */
export function showSection(sectionName) {
  // Map old section names to new panel types
  const typeMap = {
    'profile': 'profile-settings',
    'follow': 'follow',
    'discovery': 'discovery',
    'accounts': 'accounts',
    'about': 'about',
    'messages': 'messages',
    'notifications': 'notifications',
    'search': 'search',
    'trending': 'trending',
    'settings': 'settings',
    'storage': 'storage',
    'user-profile': null, // This is handled by showProfile/showThread directly
    'thread': null        // This is handled by showThread directly
  }

  const panelType = typeMap[sectionName]

  if (panelType) {
    // Use resetToPanel for nav button sections (they reset the stack)
    resetToPanel(panelType)
  } else if (sectionName === 'user-profile' || sectionName === 'thread') {
    // These are shown by showProfile/showThread, just ensure user-profile section is visible
    hideAllPanelSections()
    dom.userProfileSection?.classList.remove('hidden')
  } else {
    // Default to Swarm ID
    resetToPanel('swarm-id')
  }
}

/**
 * Show a user's profile in the right panel
 */
export async function showProfile(pubkey, timeline) {
  state.selectedProfile = pubkey

  // Get profile data - check peerProfiles first, then FoF profiles, then cached posts
  const isMe = pubkey === state.identity?.pubkeyHex
  let profile = isMe ? state.myProfile : state.peerProfiles[pubkey]
  let isFoFProfile = false

  // If not found in peerProfiles, check FoF profiles
  if (!profile && !isMe && state.fof) {
    profile = state.fof.getFoFProfile(pubkey)
    if (profile) {
      isFoFProfile = true
    }
  }

  // If still not found, check FoF cache for posts by this author
  if (!profile && !isMe && state.fofCache) {
    const cachedPosts = state.fofCache.getAll()
    const authorPost = cachedPosts.find(p => p.pubkey === pubkey)
    if (authorPost && (authorPost.authorName || authorPost.authorBio)) {
      profile = {
        name: authorPost.authorName,
        swarmId: authorPost.authorSwarmId,
        bio: authorPost.authorBio,
        avatar: authorPost.authorAvatar,
        website: authorPost.authorWebsite
      }
      isFoFProfile = true
    }
  }

  // Get display name - use FoF profile name if available
  let displayName
  if (isFoFProfile && profile?.name) {
    displayName = profile.name
  } else {
    displayName = getDisplayName(pubkey, state.identity, state.myProfile, state.peerProfiles)
  }

  // Get deleted timestamps for this user only (already author-scoped by filter)
  const deletedTimestamps = new Set(
    timeline.filter(p => p.type === 'delete' && p.pubkey === pubkey).map(p => p.post_timestamp)
  )

  // Filter posts by this user (pubkey already matches so timestamp-only is fine here)
  const userPosts = timeline.filter(p =>
    p.type === 'post' &&
    p.pubkey === pubkey &&
    !deletedTimestamps.has(p.timestamp)
  )

  // Update panel title
  dom.panelTitle.textContent = displayName

  // Render profile view
  const initial = displayName.charAt(0).toUpperCase()
  const bio = profile?.bio || 'No bio yet'
  const website = profile?.website || null
  const postCount = userPosts.length

  // Avatar: use image if available, otherwise initial
  const safeAvatar = safeAvatarUrl(profile?.avatar)
  const avatarContent = safeAvatar
    ? `<img src="${escapeHtml(safeAvatar)}" alt="avatar" style="width: 100%; height: 100%; object-fit: cover;">`
    : escapeHtml(initial)

  // Website: render as clickable link if valid URL
  let websiteHtml = ''
  const url = safeWebsiteUrl(website)
  if (url) {
    websiteHtml = `
      <div class="profile-view-website">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(website)}</a>
      </div>
    `
  }

  // Get swarm ID for this user (for Copy Swarm ID button and Follow button)
  // For self, use state.feed.swarmId; for others, find in swarmIdToPubkey map or FoF profile
  let swarmId = null
  if (isMe) {
    swarmId = state.feed?.swarmId
  } else if (isFoFProfile && profile?.swarmId) {
    // FoF profiles have swarmId stored
    swarmId = profile.swarmId
  } else {
    // Find swarm ID from pubkey (reverse lookup)
    for (const [sid, pk] of Object.entries(state.swarmIdToPubkey)) {
      if (pk === pubkey) {
        swarmId = sid
        break
      }
    }
  }

  // Build action buttons
  let actionsHtml = ''
  if (!isMe) {
    const buttons = []

    // Follow button for FoF profiles (users we don't follow yet)
    if (isFoFProfile && swarmId) {
      buttons.push(`<button class="profile-follow-btn" id="profileFollowBtn" data-swarm-id="${escapeHtml(swarmId)}">Follow</button>`)
    }

    // Copy Swarm ID button
    if (swarmId) {
      buttons.push(`<button class="profile-copy-swarm-btn" id="profileCopySwarmBtn">Copy Swarm ID</button>`)
    }

    if (buttons.length > 0) {
      actionsHtml = `<div class="profile-view-actions" id="profileViewActions">${buttons.join('')}</div>`
    } else {
      actionsHtml = '<div class="profile-view-actions" id="profileViewActions"></div>'
    }
  }

  const followingCount = getFollowingForPubkey(pubkey).length
  const followersCount = getFollowersCount(pubkey)

  // Check if this user has a paid supporter listing (Supporter badge)
  const listingManager = getSupporterManager()
  const isSupporter = listingManager.isListed(pubkey)
  const supporterBadge = isSupporter
    ? '<span class="supporter-badge" title="Paid listing - supports Swarmnero development"><span class="badge-icon">★</span>Supporter</span>'
    : ''

  dom.panelContent.innerHTML = `
    <div class="profile-view">
      <div class="profile-view-avatar">${avatarContent}</div>
      <div class="profile-view-name">${escapeHtml(displayName)} ${getOnlineDotHtml(pubkey)}${supporterBadge}</div>
      <div class="profile-view-bio">${escapeHtml(bio)}</div>
      ${websiteHtml}
      ${actionsHtml}
      <div class="profile-view-stats">
        <div class="stat">
          <span class="stat-value">${postCount}</span>
          <span class="stat-label">Posts</span>
        </div>
        <button class="stat profile-stat-btn" id="profileFollowingBtn" data-pubkey="${escapeHtml(pubkey || '')}">
          <span class="stat-value">${followingCount}</span>
          <span class="stat-label">Following</span>
        </button>
        <button class="stat profile-stat-btn" id="profileFollowersBtn" data-pubkey="${escapeHtml(pubkey || '')}">
          <span class="stat-value">${followersCount}</span>
          <span class="stat-label">Followers</span>
        </button>
      </div>
      ${swarmId ? `
        <div class="profile-view-swarm-id">
          <span class="swarm-id-label">Swarm ID</span>
          <code class="swarm-id-value">${escapeHtml(swarmId)}</code>
        </div>
      ` : ''}
      <div class="profile-view-posts">
        <h4>All Posts</h4>
        ${userPosts.length === 0
          ? '<div class="empty" style="padding: 20px 0;">No posts yet</div>'
          : userPosts.map(post => `
            <div class="profile-post clickable" data-pubkey="${escapeHtml(post.pubkey || '')}" data-timestamp="${escapeHtml(String(post.timestamp || ''))}">
              <div class="profile-post-content">${escapeHtml(post.content || '')}</div>
              <div class="profile-post-time">${formatTime(post.timestamp)}</div>
            </div>
          `).join('')
        }
      </div>
    </div>
  `

  // Copy Swarm ID button handler
  const copyBtn = document.getElementById('profileCopySwarmBtn')
  if (copyBtn && swarmId) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(swarmId)
        copyBtn.textContent = 'Copied!'
        copyBtn.classList.add('copied')
        setTimeout(() => {
          copyBtn.textContent = 'Copy Swarm ID'
          copyBtn.classList.remove('copied')
        }, 2000)
      } catch (err) {
        console.error('Copy failed:', err)
      }
    })
  }

  // Follow button handler (for FoF profiles)
  const followBtn = document.getElementById('profileFollowBtn')
  if (followBtn) {
    followBtn.addEventListener('click', async () => {
      const followSwarmId = followBtn.dataset.swarmId
      if (!followSwarmId) return

      followBtn.disabled = true
      followBtn.textContent = 'Following...'

      try {
        const { createFollowEvent } = await import('../../lib/events.js')
        await state.feed.append(createFollowEvent({ swarmId: followSwarmId }))
        await state.feed.follow(followSwarmId)
        followBtn.textContent = 'Followed!'

        // Trigger UI refresh to update profile view
        if (state.refreshUI) {
          await state.refreshUI()
        }
      } catch (err) {
        console.error('Follow failed:', err)
        followBtn.disabled = false
        followBtn.textContent = 'Follow'
      }
    })
  }

  // Add Message button for other users (not self)
  if (!isMe) {
    const actionsContainer = document.getElementById('profileViewActions')
    if (actionsContainer) {
      import('./messages.js').then(m => {
        m.addMessageButtonToProfile(actionsContainer, pubkey)
      })
    }
  }

  // Clickable posts -> open thread in center column
  dom.panelContent.querySelectorAll('.profile-post.clickable').forEach(post => {
    post.addEventListener('click', async () => {
      const postPubkey = post.dataset.pubkey
      const postTimestamp = parseInt(post.dataset.timestamp)
      // Import and call showThreadInCenter
      const { showThreadInCenter } = await import('./timeline.js')
      await showThreadInCenter(postPubkey, postTimestamp)
    })
  })

  // Following button handler
  const followingBtn = document.getElementById('profileFollowingBtn')
  if (followingBtn) {
    followingBtn.addEventListener('click', () => {
      showFollowingModal(pubkey)
    })
  }

  // Followers button handler
  const followersBtn = document.getElementById('profileFollowersBtn')
  if (followersBtn) {
    followersBtn.addEventListener('click', () => {
      showFollowersModal(pubkey)
    })
  }

  // Remove active from nav buttons when showing user profile
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))

  // Note: Panel visibility is handled by showPanelView/pushPanel
}

// Callback for refreshing UI after actions
let refreshUICallback = null

/**
 * Set the refresh callback
 */
export function setRefreshCallback(callback) {
  refreshUICallback = callback
}

/**
 * Show a thread in the right panel
 */
export async function showThread(rootPubkey, rootTimestamp, focusReply = false) {
  state.selectedThread = { pubkey: rootPubkey, timestamp: rootTimestamp }
  state.selectedProfile = null

  const timeline = state.currentTimeline
  const thread = buildThread(timeline, rootPubkey, rootTimestamp)

  if (!thread) {
    dom.panelTitle.textContent = 'Thread'
    dom.panelContent.innerHTML = '<div class="empty">Post not found</div>'
    // Note: Panel visibility is handled by showPanelView/pushPanel
    return
  }

  const myPubkey = state.identity?.pubkeyHex
  dom.panelTitle.textContent = 'Thread'

  // Render the thread tree
  function renderPost(post, isRoot = false) {
    const displayName = getDisplayName(post.pubkey, state.identity, state.myProfile, state.peerProfiles)
    const counts = getInteractionCounts(timeline, post.pubkey, post.timestamp)
    const panelReactions = counts.reactions || []
    const panelMyReaction = getUserReaction(timeline, myPubkey, post.pubkey, post.timestamp)
    const reposted = hasReposted(timeline, myPubkey, post.pubkey, post.timestamp)
    const isOwnPost = post.pubkey === myPubkey
    const safePk = escapeHtml(post.pubkey || '')
    const safeTs = escapeHtml(String(post.timestamp || ''))

    const hasMedia = post.media && post.media.length > 0

    const chipsHtml = panelReactions.map(r => {
      const mine = panelMyReaction === r.emoji
      const cls = `reaction-chip${mine ? ' mine' : ''}`
      const disabled = isOwnPost ? ' disabled' : ''
      return `<button class="${cls}" data-pubkey="${safePk}" data-timestamp="${safeTs}" data-emoji="${escapeHtml(r.emoji)}"${disabled} title="React">
        <span class="reaction-emoji">${escapeHtml(r.emoji)}</span>
        <span class="reaction-count">${r.count}</span>
      </button>`
    }).join('')
    const addHtml = !isOwnPost ? `<button class="reaction-add-btn panel-reaction-add" data-pubkey="${safePk}" data-timestamp="${safeTs}" title="Add reaction">
      <span class="reaction-add-icon">+</span>
    </button>
    <div class="reaction-picker hidden panel-reaction-picker" data-pubkey="${safePk}" data-timestamp="${safeTs}">
      <div class="reaction-picker-grid"></div>
    </div>` : ''

    return `
      <div class="thread-post ${isRoot ? 'thread-root' : 'thread-reply'}" data-pubkey="${safePk}" data-timestamp="${safeTs}">
        <div class="thread-post-header">
          <span class="thread-post-author">${escapeHtml(displayName)}</span>
          <span class="thread-post-time">${formatTime(post.timestamp)}</span>
        </div>
        <div class="thread-post-content">${renderMarkdown(post.content || '')}</div>
        ${hasMedia ? `<div class="thread-post-media" data-media-pubkey="${safePk}" data-media-ts="${safeTs}"></div>` : ''}
        <div class="thread-post-actions">
          <div class="reactions-cluster">${chipsHtml}${addHtml}</div>
          <button class="action-btn thread-repost-btn ${reposted ? 'reposted' : ''}" data-pubkey="${safePk}" data-timestamp="${safeTs}">
            <span class="action-icon">\u21BB</span>
            <span class="action-count">${counts.reposts || ''}</span>
          </button>
          <button class="action-btn thread-reply-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">
            <span class="action-icon">\u{1F4AC}</span>
            <span class="action-count">${counts.replies || ''}</span>
          </button>
        </div>
        ${post.replies && post.replies.length > 0 ? `
          <div class="thread-replies">
            ${post.replies.map(reply => renderPost(reply, false)).join('')}
          </div>
        ` : ''}
      </div>
    `
  }

  dom.panelContent.innerHTML = `
    <div class="thread-view">
      ${renderPost(thread, true)}
      <div class="thread-reply-form">
        <div class="thread-reply-toolbar">
          <button type="button" class="toolbar-btn" id="threadBoldBtn" title="Bold">B</button>
          <button type="button" class="toolbar-btn" id="threadItalicBtn" title="Italic"><em>I</em></button>
          <button type="button" class="toolbar-btn" id="threadCodeBtn" title="Code">&lt;/&gt;</button>
          <button type="button" class="toolbar-btn" id="threadLinkBtn" title="Link">&#128279;</button>
          <div class="toolbar-divider"></div>
          <button type="button" class="toolbar-btn" id="threadMediaBtn" title="Attach image/video">&#128247;</button>
          <button type="button" class="toolbar-btn" id="threadFileBtn" title="Attach file">&#128206;</button>
          <button type="button" class="toolbar-btn" id="threadEmojiBtn" title="Emoji">&#128512;</button>
        </div>
        <div style="position: relative;">
          <div class="emoji-picker" id="threadEmojiPicker">
            <div class="emoji-grid" id="threadEmojiGrid"></div>
          </div>
        </div>
        <textarea id="threadReplyInput" placeholder="Write a reply..." rows="3"></textarea>
        <div id="threadWalletHint" class="composer-hint ${wallet.isWalletUnlocked() ? 'hidden' : ''}">
          <span class="hint-icon">&#128161;</span>
          <span class="hint-text">Unlock your wallet to enable trackable tips on this reply</span>
        </div>
        <div id="threadMediaPreview" class="media-preview"></div>
        <input type="file" id="threadMediaInput" accept="image/*,video/*" multiple style="display: none;">
        <input type="file" id="threadFileInput" multiple style="display: none;">
        <div class="thread-reply-actions">
          <span class="reply-to-label">Replying to <strong id="replyToName">${escapeHtml(getDisplayName(thread.pubkey, state.identity, state.myProfile, state.peerProfiles))}</strong></span>
          <button id="sendThreadReply" class="btn">Reply</button>
        </div>
      </div>
    </div>
  `

  // Store current reply target
  let replyTarget = { pubkey: thread.pubkey, timestamp: thread.timestamp }

  // Reaction handlers (cluster-style)
  const panelReact = async (toPubkey, postTimestamp, emoji) => {
    if (!isValidReactionEmoji(emoji)) return
    const current = getUserReaction(timeline, myPubkey, toPubkey, postTimestamp)
    if (current === emoji) return
    try {
      await state.feed.append(createReactionEvent({ toPubkey, postTimestamp, emoji }))
      if (refreshUICallback) await refreshUICallback()
      await showThread(rootPubkey, rootTimestamp, false)
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  dom.panelContent.querySelectorAll('.reaction-chip').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (btn.disabled) return
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)
      const emoji = btn.dataset.emoji
      await panelReact(toPubkey, postTimestamp, emoji)
    })
  })

  dom.panelContent.querySelectorAll('.panel-reaction-add').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pk = btn.dataset.pubkey
      const ts = btn.dataset.timestamp
      const picker = dom.panelContent.querySelector(`.panel-reaction-picker[data-pubkey="${pk}"][data-timestamp="${ts}"]`)
      if (!picker) return
      dom.panelContent.querySelectorAll('.panel-reaction-picker').forEach(p => {
        if (p !== picker) p.classList.add('hidden')
      })
      const grid = picker.querySelector('.reaction-picker-grid')
      if (grid && !grid.dataset.populated) {
        grid.dataset.populated = '1'
        for (const em of EMOJI_PICKER_LIST) {
          if (!isValidReactionEmoji(em)) continue
          const emBtn = document.createElement('button')
          emBtn.type = 'button'
          emBtn.className = 'reaction-picker-btn'
          emBtn.textContent = em
          emBtn.addEventListener('click', async (evt) => {
            evt.stopPropagation()
            picker.classList.add('hidden')
            await panelReact(pk, parseInt(ts), em)
          })
          grid.appendChild(emBtn)
        }
      }
      picker.classList.toggle('hidden')
    })
  })

  if (!dom.panelContent.dataset.reactionOutsideBound) {
    dom.panelContent.dataset.reactionOutsideBound = '1'
    dom.panelContent.addEventListener('click', (e) => {
      if (e.target.closest('.panel-reaction-add') || e.target.closest('.panel-reaction-picker')) return
      dom.panelContent.querySelectorAll('.panel-reaction-picker').forEach(p => p.classList.add('hidden'))
    })
  }

  // Add repost handlers
  dom.panelContent.querySelectorAll('.thread-repost-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const toPubkey = btn.dataset.pubkey
      const postTimestamp = parseInt(btn.dataset.timestamp)
      if (hasReposted(timeline, myPubkey, toPubkey, postTimestamp)) return
      btn.disabled = true
      try {
        await state.feed.append(createRepostEvent({ toPubkey, postTimestamp }))
        if (refreshUICallback) await refreshUICallback()
        await showThread(rootPubkey, rootTimestamp, false)
      } catch (err) {
        alert('Error: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Add reply-to handlers (clicking reply button on a post sets it as target)
  dom.panelContent.querySelectorAll('.thread-reply-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp)
      replyTarget = { pubkey, timestamp }
      const targetName = getDisplayName(pubkey, state.identity, state.myProfile, state.peerProfiles)
      document.getElementById('replyToName').textContent = targetName
      document.getElementById('threadReplyInput').focus()
    })
  })

  // Get reply form elements
  const sendBtn = document.getElementById('sendThreadReply')
  const replyInput = document.getElementById('threadReplyInput')
  const threadMediaPreview = document.getElementById('threadMediaPreview')
  const threadMediaInput = document.getElementById('threadMediaInput')
  const threadFileInput = document.getElementById('threadFileInput')

  // Clear pending media/files from previous thread
  threadPendingMedia = []
  threadPendingFiles = []

  // Initialize emoji picker for thread
  const threadEmojiGrid = document.getElementById('threadEmojiGrid')
  const threadEmojiPicker = document.getElementById('threadEmojiPicker')
  initEmojiPicker(threadEmojiGrid, threadEmojiPicker, replyInput, () => {})

  // Toolbar handlers
  document.getElementById('threadBoldBtn').addEventListener('click', () => {
    wrapSelection(replyInput, '**', '**', () => {})
    replyInput.focus()
  })

  document.getElementById('threadItalicBtn').addEventListener('click', () => {
    wrapSelection(replyInput, '*', '*', () => {})
    replyInput.focus()
  })

  document.getElementById('threadCodeBtn').addEventListener('click', () => {
    wrapSelection(replyInput, '`', '`', () => {})
    replyInput.focus()
  })

  document.getElementById('threadLinkBtn').addEventListener('click', () => {
    const start = replyInput.selectionStart
    const end = replyInput.selectionEnd
    const selectedText = replyInput.value.substring(start, end)

    if (selectedText) {
      if (/\.\w{2,}/.test(selectedText) && !selectedText.startsWith('http') && !selectedText.includes(' ')) {
        const beforeText = replyInput.value.substring(0, start)
        const afterText = replyInput.value.substring(end)
        replyInput.value = beforeText + `https://${selectedText}` + afterText
        replyInput.selectionStart = start
        replyInput.selectionEnd = start + selectedText.length + 8
      } else if (!selectedText.startsWith('http')) {
        const url = prompt('Enter URL for "' + selectedText + '":')
        if (url) {
          const beforeText = replyInput.value.substring(0, start)
          const afterText = replyInput.value.substring(end)
          replyInput.value = beforeText + `[${selectedText}](${url})` + afterText
        }
      }
    } else {
      insertAtCursor(replyInput, 'https://')
    }
    replyInput.focus()
  })

  document.getElementById('threadEmojiBtn').addEventListener('click', (e) => {
    toggleEmojiPicker(threadEmojiPicker, e)
  })

  // Media button
  document.getElementById('threadMediaBtn').addEventListener('click', () => {
    threadMediaInput.click()
  })

  // Handle media file selection (images and videos)
  threadMediaInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        threadPendingMedia.push(file)
        const div = document.createElement('div')
        div.className = 'media-preview-item'

        if (file.type.startsWith('video/')) {
          // Video preview
          div.innerHTML = `
            <div class="video-preview-icon">&#127909;</div>
            <span class="file-preview-name">${file.name.slice(0, 20)}${file.name.length > 20 ? '...' : ''}</span>
            <button class="remove-media" type="button">&times;</button>
          `
          div.querySelector('.remove-media').addEventListener('click', () => {
            const index = threadPendingMedia.indexOf(file)
            if (index > -1) threadPendingMedia.splice(index, 1)
            div.remove()
          })
          threadMediaPreview.appendChild(div)
        } else {
          // Image preview
          const reader = new FileReader()
          reader.onload = (ev) => {
            div.innerHTML = `
              <img src="${ev.target.result}" alt="preview">
              <button class="remove-media" type="button">&times;</button>
            `
            div.querySelector('.remove-media').addEventListener('click', () => {
              const index = threadPendingMedia.indexOf(file)
              if (index > -1) threadPendingMedia.splice(index, 1)
              div.remove()
            })
            threadMediaPreview.appendChild(div)
          }
          reader.readAsDataURL(file)
        }
      }
    }
    threadMediaInput.value = ''
  })

  // File button
  document.getElementById('threadFileBtn').addEventListener('click', () => {
    threadFileInput.click()
  })

  // Handle file selection. Images/videos go through the media pipeline so
  // EXIF stripping still applies — otherwise they'd hit storeFile which
  // keeps the raw bytes and original filename.
  threadFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    for (const file of files) {
      if (file.type?.startsWith('image/') || file.type?.startsWith('video/')) {
        threadPendingMedia.push(file)
        const div = document.createElement('div')
        div.className = 'media-preview-item'
        if (file.type.startsWith('video/')) {
          div.innerHTML = `
            <div class="video-preview-icon">&#127909;</div>
            <span class="file-preview-name">${file.name.slice(0, 20)}${file.name.length > 20 ? '...' : ''}</span>
            <button class="remove-media" type="button">&times;</button>
          `
          div.querySelector('.remove-media').addEventListener('click', () => {
            const index = threadPendingMedia.indexOf(file)
            if (index > -1) threadPendingMedia.splice(index, 1)
            div.remove()
          })
          threadMediaPreview.appendChild(div)
        } else {
          const reader = new FileReader()
          reader.onload = (ev) => {
            div.innerHTML = `
              <img src="${ev.target.result}" alt="preview">
              <button class="remove-media" type="button">&times;</button>
            `
            div.querySelector('.remove-media').addEventListener('click', () => {
              const index = threadPendingMedia.indexOf(file)
              if (index > -1) threadPendingMedia.splice(index, 1)
              div.remove()
            })
            threadMediaPreview.appendChild(div)
          }
          reader.readAsDataURL(file)
        }
        continue
      }
      threadPendingFiles.push(file)
      const div = document.createElement('div')
      div.className = 'media-preview-item file-preview'
      div.innerHTML = `
        <div class="file-preview-icon">&#128206;</div>
        <span class="file-preview-name">${file.name.slice(0, 20)}${file.name.length > 20 ? '...' : ''}</span>
        <button class="remove-media" type="button">&times;</button>
      `
      div.querySelector('.remove-media').addEventListener('click', () => {
        const index = threadPendingFiles.indexOf(file)
        if (index > -1) threadPendingFiles.splice(index, 1)
        div.remove()
      })
      threadMediaPreview.appendChild(div)
    }
    threadFileInput.value = ''
  })

  // Send reply handler
  sendBtn.addEventListener('click', async () => {
    const content = replyInput.value.trim()
    if (!content && threadPendingMedia.length === 0 && threadPendingFiles.length === 0) return

    sendBtn.disabled = true
    try {
      // Upload pending media (images and videos)
      const uploadedMedia = []
      if (state.media && threadPendingMedia.length > 0) {
        for (const file of threadPendingMedia) {
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
      if (state.media && threadPendingFiles.length > 0) {
        for (const file of threadPendingFiles) {
          const result = await state.media.storeFile(file, file.name)
          uploadedMedia.push(result)
        }
      }

      const replyEvent = await state.feed.append(createReplyEvent({
        toPubkey: replyTarget.pubkey,
        postTimestamp: replyTarget.timestamp,
        content,
        media: uploadedMedia.length > 0 ? uploadedMedia : undefined
      }))
      replyInput.value = ''
      threadPendingMedia = []
      threadPendingFiles = []
      threadMediaPreview.innerHTML = ''

      // Send reply notification to OP if they don't follow us
      if (state.replyNotify && replyTarget.pubkey !== state.identity?.pubkeyHex) {
        const opSwarmId = state.pubkeyToSwarmId?.[replyTarget.pubkey]
        if (opSwarmId && !state.feed.followers.has(opSwarmId)) {
          const myProfile = state.myProfile || {}
          state.replyNotify.notifyReply({
            opPubkey: replyTarget.pubkey,
            opSwarmId,
            postTimestamp: replyTarget.timestamp,
            reply: replyEvent,
            author: {
              name: myProfile.name || '',
              swarmId: state.feed.swarmId,
              avatar: myProfile.avatar
            }
          }).catch(err => console.warn('[Panel] Error sending reply notification:', err.message))
        }
      }

      if (refreshUICallback) await refreshUICallback()
      // Re-render thread to show new reply
      await showThread(rootPubkey, rootTimestamp, false)
    } catch (err) {
      alert('Error: ' + err.message)
      sendBtn.disabled = false
    }
  })

  // Remove active from nav buttons
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'))

  // Note: Panel visibility is handled by showPanelView/pushPanel

  // Load images asynchronously
  const mediaContainers = dom.panelContent.querySelectorAll('.thread-post-media[data-media-pubkey]')
  for (const mediaContainer of mediaContainers) {
    const pubkey = mediaContainer.dataset.mediaPubkey
    const ts = parseInt(mediaContainer.dataset.mediaTs)

    // Find the post with this pubkey+timestamp
    const post = timeline.find(p =>
      (p.type === 'post' || p.type === 'reply') &&
      p.pubkey === pubkey &&
      p.timestamp === ts
    )
    if (post && post.media && post.media.length > 0 && state.media) {
      for (const m of post.media) {
        try {
          const url = await state.media.getImageUrl(m.driveKey, m.path)
          if (url) {
            // Check media type
            if (m.type === 'video' || m.mimeType?.startsWith('video/')) {
              // Video element
              const video = document.createElement('video')
              video.src = url
              video.className = 'post-video'
              video.controls = true
              video.preload = 'metadata'
              mediaContainer.appendChild(video)
            } else if (m.mimeType?.startsWith('image/')) {
              // Image (check mimeType first to handle images uploaded via file button)
              const img = document.createElement('img')
              img.src = url
              img.className = 'post-image'
              img.alt = 'attached image'
              mediaContainer.appendChild(img)
            } else if (m.type === 'file') {
              // File download link (non-image files)
              const fileDiv = document.createElement('div')
              fileDiv.className = 'post-file'
              fileDiv.innerHTML = `
                <span class="file-icon">&#128206;</span>
                <a href="${url}" download="${escapeHtml(m.filename || 'file')}" class="file-link">${escapeHtml(m.filename || 'Download file')}</a>
                <span class="file-size">(${formatFileSize(m.size)})</span>
              `
              mediaContainer.appendChild(fileDiv)
            } else {
              // Default fallback - treat as image
              const img = document.createElement('img')
              img.src = url
              img.className = 'post-image'
              img.alt = 'attached image'
              mediaContainer.appendChild(img)
            }
          }
        } catch (err) {
          console.error('Error loading media:', err)
        }
      }
    }
  }

  // Focus reply input if requested
  if (focusReply) {
    replyInput.focus()
  }
}

/**
 * Initialize panel component - close button and back button handlers
 */
export function initPanel() {
  // Handle all close buttons (resets to Swarm ID)
  document.querySelectorAll('.close-panel').forEach(btn => {
    btn.addEventListener('click', () => {
      hideAllSections()
    })
  })

  // Handle back button (uses navigation stack)
  const backBtn = document.getElementById('backToSwarmId')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      popPanel()
    })
  }
}
