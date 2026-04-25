/**
 * Profile component - profile form and saving
 */

import { state, dom } from '../state.js'
import { createProfileEvent } from '../../lib/events.js'
import * as wallet from '../../lib/wallet.js'
import { getFollowingForPubkey, getFollowersCount, showFollowingModal, showFollowersModal } from './panel.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'
import { runFeedBackupPurchase } from './feed-backup.js'
import { escapeHtml } from '../utils/dom.js'
import { schedulePublicSiteRebuild } from '../../app.js'
import { publicSiteStorage } from '../../lib/public-site.js'

// Reserved display names (case-insensitive). Value is the swarmId of the sole
// account permitted to use the name, or null if no account may claim it.
const OFFICIAL_SWARM_ID = '9aa8bf64357d4db09ea62aa6ddd771affc161d43624e3d162e1d115af5503e74'
const RESERVED_NAMES = {
  'swarmnero': OFFICIAL_SWARM_ID,
  'admin': null,
  'administrator': null,
  'moderator': null,
  'official': null,
  'support': null,
  'system': null,
  'bot': null
}

/**
 * Check if a name is reserved for the given account's swarmId.
 */
function isReservedName(name, ownerSwarmId = null) {
  if (!name) return false
  const lower = name.toLowerCase()
  if (!(lower in RESERVED_NAMES)) return false
  return RESERVED_NAMES[lower] !== ownerSwarmId
}

// Pending avatar data (base64 data URL after resize)
let pendingAvatar = null

/**
 * Resize an image file to avatar dimensions (150x150)
 * Returns a base64 data URL
 */
async function resizeImageToAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        // Create canvas at avatar size
        const canvas = document.createElement('canvas')
        const size = 150
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')

        // Calculate crop to center the image (square crop)
        const minDim = Math.min(img.width, img.height)
        const sx = (img.width - minDim) / 2
        const sy = (img.height - minDim) / 2

        // Draw cropped and resized image
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size)

        // Convert to JPEG for smaller file size
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        resolve(dataUrl)
      }
      img.onerror = reject
      img.src = e.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Update avatar preview with current profile or pending avatar
 */
function updateAvatarPreview() {
  const avatar = pendingAvatar || state.myProfile?.avatar
  const name = dom.profileNameEl?.value || state.myProfile?.name || ''
  const initial = name ? name.charAt(0).toUpperCase() : '?'

  if (avatar) {
    // Show avatar image
    dom.avatarPreview.innerHTML = `<img src="${avatar}" alt="avatar">`
    dom.removeAvatarBtn.style.display = 'inline-block'
  } else {
    // Show initial
    dom.avatarPreview.innerHTML = `<span class="avatar-initial">${initial}</span>`
    dom.removeAvatarBtn.style.display = 'none'
  }
}

/**
 * Update the Following/Followers counts in the My Profile section
 */
export function updateMyProfileStats() {
  const myPubkey = state.identity?.pubkeyHex
  if (!myPubkey) return

  const followingCount = getFollowingForPubkey(myPubkey).length
  const followersCount = getFollowersCount(myPubkey)

  const followingEl = document.getElementById('myFollowingCount')
  const followersEl = document.getElementById('myFollowersCount')

  if (followingEl) followingEl.textContent = followingCount
  if (followersEl) followersEl.textContent = followersCount
}

/**
 * Update profile Monero address with a fresh subaddress from wallet
 * Called automatically when wallet is unlocked
 * This improves privacy by rotating addresses and ensures tips are trackable
 */
export async function updateProfileWithNewSubaddress() {
  if (!wallet.isWalletUnlocked()) {
    console.log('[Profile] Wallet not unlocked, skipping address update')
    return false
  }

  if (!state.feed || !state.identity) {
    console.log('[Profile] Feed or identity not available, skipping address update')
    return false
  }

  try {
    // Generate a new subaddress
    const { address, index } = await wallet.getReceiveAddress(true)
    console.log('[Profile] Generated new subaddress for profile, index:', index)

    // Get current profile values to preserve them
    const currentProfile = state.myProfile || {}

    // Create updated profile event with new address
    await state.feed.append(createProfileEvent({
      name: currentProfile.name || '',
      bio: currentProfile.bio || '',
      avatar: currentProfile.avatar || null,
      website: currentProfile.website || null,
      moneroAddress: address,
      swarmId: state.feed.swarmId
    }))
    schedulePublicSiteRebuild()

    console.log('[Profile] Updated profile with new subaddress')

    // Update form field if visible
    if (dom.profileMoneroAddress) {
      dom.profileMoneroAddress.value = address
    }

    return true
  } catch (err) {
    console.error('[Profile] Error updating profile with subaddress:', err)
    return false
  }
}

/**
 * Update profile form with current values
 * Auto-populates XMR address from wallet if available and not already set
 */
export async function updateProfileForm() {
  // Reset pending avatar when form updates
  pendingAvatar = null

  // Update Following/Followers stats
  updateMyProfileStats()

  // Update Swarm ID display — truncated (full ID is shown via Show button → modal)
  const swarmIdEl = document.getElementById('mySwarmIdValue')
  if (swarmIdEl && state.feed?.swarmId) {
    const id = state.feed.swarmId
    swarmIdEl.textContent = `${id.slice(0, 8)}…${id.slice(-8)}`
    swarmIdEl.title = id
  }

  // Always set form values from state.myProfile
  // For new accounts with no profile, default the name to the account name
  dom.profileNameEl.value = state.myProfile?.name || state.activeAccountName || ''
  dom.profileBioEl.value = state.myProfile?.bio || ''

  if (dom.profileWebsite) {
    dom.profileWebsite.value = state.myProfile?.website || ''
  }
  if (dom.profileMoneroAddress) {
    // Use saved address if exists, otherwise try to get from wallet
    if (state.myProfile?.monero_address) {
      dom.profileMoneroAddress.value = state.myProfile.monero_address
    } else if (state.activeAccountName) {
      // Clear first, then try to auto-populate from wallet
      dom.profileMoneroAddress.value = ''
      const walletAddress = await wallet.getPrimaryAddress(state.activeAccountName)
      if (walletAddress) {
        dom.profileMoneroAddress.value = walletAddress
      }
    } else {
      dom.profileMoneroAddress.value = ''
    }
  }

  // Update avatar preview
  updateAvatarPreview()

  // Update sync section for supporters
  renderProfileSyncSection()
  renderProfileRenewalBanner()
  renderProfilePublicSiteSection()
}

/**
 * Initialize profile component - save button and avatar handlers
 */
export function initProfile(refreshUI) {
  // Following/Followers button handlers
  const myFollowingBtn = document.getElementById('myFollowingBtn')
  const myFollowersBtn = document.getElementById('myFollowersBtn')

  if (myFollowingBtn) {
    myFollowingBtn.addEventListener('click', () => {
      const myPubkey = state.identity?.pubkeyHex
      if (myPubkey) showFollowingModal(myPubkey)
    })
  }

  if (myFollowersBtn) {
    myFollowersBtn.addEventListener('click', () => {
      const myPubkey = state.identity?.pubkeyHex
      if (myPubkey) showFollowersModal(myPubkey)
    })
  }

  // Copy Swarm ID button
  const swarmCopyBtn = document.getElementById('mySwarmIdCopy')
  if (swarmCopyBtn) {
    swarmCopyBtn.addEventListener('click', () => {
      const swarmId = state.feed?.swarmId
      if (swarmId) {
        navigator.clipboard.writeText(swarmId)
        swarmCopyBtn.textContent = 'Copied!'
        setTimeout(() => { swarmCopyBtn.textContent = 'Copy' }, 2000)
      }
    })
  }

  // Avatar upload button
  dom.uploadAvatarBtn.addEventListener('click', () => {
    dom.avatarInput.click()
  })

  // Handle avatar file selection
  dom.avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file')
      return
    }

    // Reject SVG (can contain embedded scripts)
    if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
      alert('SVG files are not supported for avatars. Please use JPEG, PNG, or WebP.')
      return
    }

    try {
      // Resize to avatar size
      pendingAvatar = await resizeImageToAvatar(file)
      updateAvatarPreview()
    } catch (err) {
      console.error('Error processing avatar:', err)
      alert('Error processing image')
    }

    // Clear the input
    dom.avatarInput.value = ''
  })

  // Remove avatar button
  dom.removeAvatarBtn.addEventListener('click', () => {
    pendingAvatar = null
    // Clear from profile as well (will be saved with null)
    updateAvatarPreview()
    // Force remove button to stay visible if there was an existing avatar
    if (state.myProfile?.avatar) {
      dom.removeAvatarBtn.style.display = 'inline-block'
    }
  })

  // Update initial when name changes
  dom.profileNameEl.addEventListener('input', () => {
    if (!pendingAvatar && !state.myProfile?.avatar) {
      updateAvatarPreview()
    }
  })

  // Save profile button
  dom.saveProfileBtn.addEventListener('click', async () => {
    dom.saveProfileBtn.disabled = true
    try {
      const profileName = dom.profileNameEl.value.trim()

      // Check if name is reserved (allows the real owner's swarmId to claim it)
      if (isReservedName(profileName, state.feed?.swarmId)) {
        alert('This name is reserved and cannot be used')
        dom.saveProfileBtn.disabled = false
        return
      }

      // Determine avatar value:
      // - If pendingAvatar is set, use it (new upload)
      // - If pendingAvatar is null and remove was clicked, save null
      // - If neither, preserve existing avatar
      let avatarToSave = pendingAvatar
      if (avatarToSave === null && state.myProfile?.avatar && dom.removeAvatarBtn.style.display === 'inline-block') {
        // User didn't click remove, preserve existing
        avatarToSave = state.myProfile.avatar
      }

      await state.feed.append(createProfileEvent({
        name: profileName,
        bio: dom.profileBioEl.value.trim(),
        avatar: avatarToSave,
        website: dom.profileWebsite?.value.trim() || null,
        moneroAddress: dom.profileMoneroAddress?.value.trim() || null,
        swarmId: state.feed.swarmId
      }))

      schedulePublicSiteRebuild()

      // Clear pending avatar after save
      pendingAvatar = null

      // Cache profile name for welcome screen display
      if (state.accountManager && state.activeAccountName && profileName) {
        await state.accountManager.updateProfileName(state.activeAccountName, profileName)
      }
      await refreshUI()

      // Show "Saved!" feedback for 2 seconds
      dom.saveProfileBtn.textContent = 'Saved!'
      setTimeout(() => {
        dom.saveProfileBtn.textContent = 'Save'
      }, 2000)
    } catch (err) {
      alert('Error saving profile: ' + err.message)
    }
    dom.saveProfileBtn.disabled = false
  })
}

// Latest sync status from server (refreshed periodically)
let latestSyncStatus = null
let syncStatusInterval = null

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Format a timestamp as relative time (e.g. "5 minutes ago")
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return 'never'
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/**
 * Get a friendly status label and class
 * Compares server's block count to our local feed length to determine
 * whether the backup is up to date.
 */
function getSyncStatusDisplay(status) {
  if (!status || !status.active) {
    return { label: 'Inactive', cls: 'sync-status-inactive' }
  }
  if (!state.syncClient?.isConnected) {
    return { label: 'Connecting...', cls: 'sync-status-connecting' }
  }
  if (!status.peerConnected) {
    return { label: 'Server idle', cls: 'sync-status-idle' }
  }

  const myLength = state.feed?.core?.length || 0
  const serverLength = status.blockCount || 0

  if (serverLength >= myLength && myLength > 0) {
    return { label: 'All Posts Synced', cls: 'sync-status-synced' }
  }
  if (serverLength < myLength) {
    return { label: `Syncing ${serverLength} / ${myLength} posts`, cls: 'sync-status-syncing' }
  }
  return { label: 'Synced', cls: 'sync-status-synced' }
}

/**
 * Render the header sync status indicator
 * - Non-supporters: "Enable backup" link → opens Discovery (Supporters tab) and triggers signup
 * - Supporters who haven't enabled backup: "Enable backup" link → opens profile settings
 * - Supporters with backup active: real status badge (Synced / Syncing X / Y / Connecting)
 */
export function renderHeaderSyncStatus() {
  const el = document.getElementById('headerSyncStatus')
  if (!el) return

  const pubkey = state.identity?.pubkeyHex
  if (!pubkey) {
    el.classList.add('hidden')
    return
  }

  el.classList.remove('hidden')

  const listingManager = getSupporterManager()
  const isSupporter = listingManager.isListed(pubkey)
  const syncActive = localStorage.getItem('swarmnero_sync_active') === 'true'

  if (!isSupporter) {
    // Non-supporter — show "Enable backup?" link that takes them to subscribe
    el.className = 'header-sync-status header-sync-enable'
    el.innerHTML = '<span class="hint">Enable backup?</span>'
    el.onclick = async () => {
      const { pushPanel } = await import('./panel.js')
      await pushPanel('discovery')
      // After discovery panel is open, click the Supporters tab and the support button
      setTimeout(() => {
        const supportersTab = document.querySelector('.discovery-tab[data-tab="supporters"]')
        if (supportersTab) supportersTab.click()
        setTimeout(() => {
          const supportBtn = document.getElementById('supportSwarmneroBtn')
          if (supportBtn) supportBtn.click()
        }, 100)
      }, 100)
    }
    return
  }

  if (!syncActive) {
    // Supporter who hasn't enabled backup yet — open profile settings
    el.className = 'header-sync-status header-sync-enable'
    el.innerHTML = '<span class="hint">Enable backup</span>'
    el.onclick = async () => {
      const { pushPanel } = await import('./panel.js')
      await pushPanel('profile-settings')
    }
    return
  }

  // Supporter with backup active — show real status
  el.onclick = async () => {
    const { pushPanel } = await import('./panel.js')
    await pushPanel('profile-settings')
  }

  const status = latestSyncStatus || { active: true }
  const display = getSyncStatusDisplay(status)
  el.className = `header-sync-status ${display.cls}`
  el.innerHTML = `<span class="header-sync-dot"></span><span class="header-sync-label">${display.label}</span>`
}

/**
 * Refresh sync status from server (called periodically)
 */
async function refreshSyncStatus() {
  if (!state.syncClient?.isConnected) {
    // Still update header to show "Connecting..." state
    renderHeaderSyncStatus()
    return
  }
  try {
    const status = await state.syncClient.requestStatus()
    if (status) {
      latestSyncStatus = status
      // Always update header
      renderHeaderSyncStatus()
      // Re-render profile section only if visible
      const section = document.getElementById('profileSyncSection')
      if (section && !section.classList.contains('hidden')) {
        renderProfileSyncSection()
      }
      renderProfileRenewalBanner()
    }
  } catch (err) {
    // Silent — periodic poll, errors expected if offline
  }
}

/**
 * Start periodic status polling
 * Polls regardless of which panel is open so the header stays current.
 */
export function startSyncStatusPolling() {
  if (syncStatusInterval) return
  syncStatusInterval = setInterval(refreshSyncStatus, 30000)
  // Also refresh immediately
  refreshSyncStatus()
}

/**
 * Stop periodic status polling
 */
export function stopSyncStatusPolling() {
  if (syncStatusInterval) {
    clearInterval(syncStatusInterval)
    syncStatusInterval = null
  }
}

/**
 * Render the feed backup sync section in profile settings.
 * Exported so panel navigation can force a fresh render — otherwise the
 * profile panel keeps stale HTML after Settings toggles backup state.
 */
export function renderProfileSyncSection() {
  const section = document.getElementById('profileSyncSection')
  if (!section) return

  const pubkey = state.identity?.pubkeyHex
  if (!pubkey) {
    section.classList.add('hidden')
    stopSyncStatusPolling()
    return
  }

  const listingManager = getSupporterManager()
  const isSupporter = listingManager.isListed(pubkey)

  if (!isSupporter) {
    section.classList.add('hidden')
    stopSyncStatusPolling()
    return
  }

  section.classList.remove('hidden')

  const syncActive = localStorage.getItem('swarmnero_sync_active') === 'true'
  const syncExpires = localStorage.getItem('swarmnero_sync_expires')
  const expiryDate = syncExpires ? new Date(parseInt(syncExpires)) : null
  const expiryStr = expiryDate ? expiryDate.toLocaleDateString() : ''

  if (syncActive) {
    // Use latest status from server, or fallback to localStorage
    const status = latestSyncStatus || { active: true }
    const display = getSyncStatusDisplay(status)
    const blockCount = status.blockCount || 0
    const storageUsed = status.storageUsed || 0
    const storageLimit = status.storageLimit || (100 * 1024 * 1024)
    const storagePct = Math.min(100, Math.round((storageUsed / storageLimit) * 100))
    const lastDownload = status.lastDownloadAt ? formatRelativeTime(status.lastDownloadAt) : null

    // Storage state banners:
    //   overCap → red "paused, existing backup still served"
    //   >= 80%  → amber "approaching cap"
    let storageBanner = ''
    if (status.overCap) {
      storageBanner = `
        <div class="sync-storage-banner sync-storage-banner-paused">
          <strong>Backup paused — 100 MB cap reached.</strong>
          <p>Your existing backup is still served to followers. New posts stop being backed up until the cap drops or your subscription renews. Subscription is still active${expiryStr ? ` through ${expiryStr}` : ''}.</p>
        </div>`
    } else if (storagePct >= 80) {
      storageBanner = `
        <div class="sync-storage-banner sync-storage-banner-warn">
          <strong>Feed backup approaching limit (${storagePct}%).</strong>
          <p>When you hit 100 MB, new posts stop being backed up. Existing backup keeps serving followers.</p>
        </div>`
    }

    section.innerHTML = `
      <div class="profile-sync-info">
        <h4>Feed Backup</h4>
        <div class="sync-status-row">
          <span class="sync-status-badge ${display.cls}">${display.label}</span>
        </div>
        ${storageBanner}
        <div class="sync-detail-row">
          <span class="sync-detail-label">Posts backed up</span>
          <span class="sync-detail-value">${blockCount}</span>
        </div>
        ${lastDownload ? `
          <div class="sync-detail-row">
            <span class="sync-detail-label">Last update</span>
            <span class="sync-detail-value">${lastDownload}</span>
          </div>
        ` : ''}
        <div class="sync-detail-row">
          <span class="sync-detail-label">Storage</span>
          <span class="sync-detail-value">${formatBytes(storageUsed)} / ${formatBytes(storageLimit)}</span>
        </div>
        <div class="sync-storage-bar">
          <div class="sync-storage-fill ${status.overCap ? 'paused' : storagePct >= 80 ? 'warn' : ''}" style="width: ${storagePct}%"></div>
        </div>
        ${expiryStr ? `<p class="hint">Expires: ${expiryStr}</p>` : ''}
        <p class="hint">Your posts are available 24/7 even when you're offline.</p>
        <button type="button" id="profileDisableSync" class="btn-small btn-danger">Disable Backup</button>
        <div id="profileSyncToggleStatus" class="hint"></div>
      </div>
    `

    const disableBtn = section.querySelector('#profileDisableSync')
    if (disableBtn) {
      disableBtn.addEventListener('click', async () => {
        if (!confirm('Disable feed backup? Your posts will only be available when you are online.')) return
        const statusEl = section.querySelector('#profileSyncToggleStatus')
        disableBtn.disabled = true
        disableBtn.textContent = 'Disabling…'
        try {
          const { runFeedBackupDisable } = await import('./feed-backup.js')
          await runFeedBackupDisable({
            onStatus: (msg) => { if (statusEl) statusEl.textContent = msg }
          })
          renderProfileSyncSection()
        } catch (err) {
          console.error('[Profile] Disable error:', err.message)
          if (statusEl) statusEl.textContent = err.message
          disableBtn.disabled = false
          disableBtn.textContent = 'Disable Backup'
        }
      })
    }

    startSyncStatusPolling()
  } else {
    stopSyncStatusPolling()
    section.innerHTML = `
      <div class="profile-sync-info">
        <h4>Feed Backup</h4>
        <p class="hint">Keep your posts available 24/7 even when you're offline. Included with your supporter subscription.</p>
        <button type="button" id="profileEnableSync" class="btn-secondary">Enable Feed Backup</button>
        <div id="profileSyncStatus" class="sync-setup-status"></div>
      </div>
    `

    const enableBtn = section.querySelector('#profileEnableSync')
    if (enableBtn) {
      enableBtn.addEventListener('click', async () => {
        const statusEl = section.querySelector('#profileSyncStatus')
        enableBtn.disabled = true
        enableBtn.textContent = 'Starting…'

        try {
          const result = await runFeedBackupPurchase({
            onStatus: (msg) => { if (statusEl) statusEl.textContent = msg }
          })

          if (result.ok) {
            renderProfileSyncSection()
            return
          }
        } catch (err) {
          console.error('[Profile] Sync enable error:', err.message)
          if (statusEl) statusEl.textContent = err.message
          enableBtn.disabled = false
          enableBtn.textContent = 'Enable Feed Backup'
        }
      })
    }
  }
}

/**
 * Render the subscription renewal banner when the user's supporter listing is
 * within 30 days of expiry (amber) or already expired (red). Hidden otherwise.
 *
 * Clicking Renew opens Discovery → Supporters tab and triggers the existing
 * payment flow; addListingAfterPayment detects the existing listing and calls
 * renewListing() to extend expiry rather than overwrite.
 */
export function renderProfileRenewalBanner() {
  const banner = document.getElementById('profileRenewalBanner')
  if (!banner) return

  const pubkey = state.identity?.pubkeyHex
  if (!pubkey) {
    banner.classList.add('hidden')
    return
  }

  const manager = getSupporterManager()
  const listing = manager.getListing(pubkey)
  if (!listing || !listing.paymentConfirmed) {
    banner.classList.add('hidden')
    return
  }

  const expired = manager.isExpired(pubkey)
  const renewalDue = manager.isRenewalDue(pubkey)
  if (!expired && !renewalDue) {
    banner.classList.add('hidden')
    return
  }

  banner.classList.remove('hidden')
  const msUntil = manager.getMsUntilExpiry(pubkey)
  const days = msUntil !== null ? Math.ceil(msUntil / (24 * 60 * 60 * 1000)) : null
  const expiryDate = listing.expiresAt ? new Date(listing.expiresAt).toLocaleDateString() : ''

  if (expired) {
    banner.className = 'profile-renewal-banner expired'
    banner.innerHTML = `
      <div class="renewal-banner-row">
        <strong>Supporter subscription expired</strong>
        <button type="button" id="profileRenewBtn" class="btn-primary btn-small">Renew</button>
      </div>
      <p class="hint">Renew for $12/year to restore your Supporter badge${listing ? ' and feed backup' : ''}. ${expiryDate ? `Expired ${expiryDate}.` : ''}</p>
    `
  } else {
    banner.className = 'profile-renewal-banner renewal-due'
    const dayLabel = days === 1 ? 'day' : 'days'
    banner.innerHTML = `
      <div class="renewal-banner-row">
        <strong>Subscription renews soon</strong>
        <button type="button" id="profileRenewBtn" class="btn-primary btn-small">Renew Now</button>
      </div>
      <p class="hint">Expires in ${days} ${dayLabel}${expiryDate ? ` (${expiryDate})` : ''}. Renewing extends your subscription by another year.</p>
    `
  }

  const renewBtn = banner.querySelector('#profileRenewBtn')
  if (renewBtn) {
    renewBtn.addEventListener('click', async () => {
      const { pushPanel } = await import('./panel.js')
      await pushPanel('discovery')
      setTimeout(() => {
        const supportersTab = document.querySelector('.discovery-tab[data-tab="supporters"]')
        if (supportersTab) supportersTab.click()
        setTimeout(() => {
          const supportBtn = document.getElementById('supportSwarmneroBtn')
          if (supportBtn) supportBtn.click()
        }, 100)
      }, 100)
    })
  }
}

/**
 * Render the "Public hyper-site" section in profile settings.
 *
 * Shows the hyper:// URL that renders the user's profile + posts in any
 * hyper-aware browser (PearBrowser, Agregore). Opt-out toggle disables
 * regeneration and wipes the drive's public/ folder on next save.
 */
export function renderProfilePublicSiteSection() {
  const section = document.getElementById('profilePublicSiteSection')
  if (!section) return

  const pubkey = state.identity?.pubkeyHex
  const publicDrive = state.publicSiteDrive
  const driveKey = publicDrive?.key ? Array.from(publicDrive.key).map(b => b.toString(16).padStart(2, '0')).join('') : null
  if (!pubkey || !driveKey) {
    section.innerHTML = ''
    return
  }

  const dataDir = (typeof Pear !== 'undefined' && Pear.config?.storage) || null
  const enabled = publicSiteStorage.isEnabled(dataDir, pubkey)
  const hyperUrl = `hyper://${driveKey}/`

  section.innerHTML = `
    <h4 class="profile-section-heading">Public hyper-site</h4>
    <p class="profile-section-help">
      Your profile + last 100 public posts are published as a static site in your Hyperdrive. Anyone with a hyper-aware browser (PearBrowser, Agregore) can read it at your hyper-site address — shareable outside Swarmnero. Paywalled post bodies and replies are not included.
    </p>
    <label class="profile-public-site-toggle">
      <input type="checkbox" id="publicSiteToggle" ${enabled ? 'checked' : ''}>
      <span>Publish public hyper-site</span>
    </label>
    <div class="profile-public-site-actions ${enabled ? '' : 'disabled'}">
      <button type="button" id="copyPublicSiteUrlBtn" class="btn-small" ${enabled ? '' : 'disabled'}>Copy hyper-site address</button>
      <button type="button" id="viewPublicSiteUrlBtn" class="btn-small secondary-btn" ${enabled ? '' : 'disabled'}>View</button>
    </div>
  `

  const toggle = document.getElementById('publicSiteToggle')
  if (toggle) {
    toggle.addEventListener('change', async () => {
      publicSiteStorage.setEnabled(dataDir, pubkey, toggle.checked)
      schedulePublicSiteRebuild()
      renderProfilePublicSiteSection()
    })
  }

  const copyBtn = document.getElementById('copyPublicSiteUrlBtn')
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(hyperUrl)
        const original = copyBtn.textContent
        copyBtn.textContent = 'Copied!'
        setTimeout(() => { copyBtn.textContent = original }, 2000)
      } catch (err) {
        alert('Copy failed: ' + err.message)
      }
    })
  }

  const viewBtn = document.getElementById('viewPublicSiteUrlBtn')
  if (viewBtn) {
    viewBtn.addEventListener('click', () => showPublicSiteUrlModal(hyperUrl))
  }
}

function showPublicSiteUrlModal(hyperUrl) {
  const modal = document.getElementById('publicSiteUrlModal')
  const valueEl = document.getElementById('publicSiteUrlModalValue')
  const closeBtn = document.getElementById('publicSiteUrlModalClose')
  const copyBtn = document.getElementById('publicSiteUrlModalCopy')
  if (!modal || !valueEl || !closeBtn || !copyBtn) return

  valueEl.textContent = hyperUrl
  modal.classList.remove('hidden')

  const close = () => {
    modal.classList.add('hidden')
    closeBtn.removeEventListener('click', close)
    copyBtn.removeEventListener('click', onCopy)
  }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(hyperUrl)
      const original = copyBtn.textContent
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = original }, 2000)
    } catch (err) {
      alert('Copy failed: ' + err.message)
    }
  }
  closeBtn.addEventListener('click', close)
  copyBtn.addEventListener('click', onCopy)
}
