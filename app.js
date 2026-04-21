/** @typedef {import('pear-interface')} */ /* global Pear */
import { Feed } from './lib/feed.js'
import { Media } from './lib/media.js'
import { AccountManager } from './lib/accounts.js'
import { getLatestProfile, getLatestDiscoveryProfile, countTipsForPost, buildSubaddressToPostMap, createTipReceivedEvent, createFollowEvent, createUnfollowEvent, createProfileEvent } from './lib/events.js'
import { parseSwarmId } from './ui/utils/dom.js'

// UI modules
import { state, dom, initDom, initState } from './ui/state.js'
import { initComposer, showExpandedComposer } from './ui/components/composer.js'
import { renderPosts, scheduleRefresh, setOnAuthorClick, setOnThreadClick, setRefreshUICallback, resetTimelinePagination, showToast } from './ui/components/timeline.js'
import { initProfile, updateProfileForm, updateProfileWithNewSubaddress, renderHeaderSyncStatus, startSyncStatusPolling, stopSyncStatusPolling } from './ui/components/profile.js'
import { initFollow, renderFollowing } from './ui/components/follow.js'
import { initPanel, showSection, hideAllSections, setRefreshCallback, pushPanel, popPanel, setRenderWalletCallback } from './ui/components/panel.js'
import { initAccounts, renderAccountDropdown, setOnAccountSwitch } from './ui/components/accounts.js'
import { initWallet, renderWalletPanel } from './ui/components/wallet.js'
import { initTip } from './ui/components/tip.js'
import { initMessages, updateUnreadBadge, hideDMChat } from './ui/components/messages.js'
import { initDiscovery, renderDiscovery, setupDiscoveryCallbacks, updateDiscoveryProfile } from './ui/components/discovery.js'
import { FoFCache } from './lib/fof-cache.js'
import { FoF } from './lib/fof.js'
import { ReplyNotify } from './lib/reply-notify.js'
import { TipBatcher } from './lib/tip-batcher.js'
import { getTagIndex } from './lib/tag-index.js'
import { renderSearch, setupSearchHandlers, initSearch } from './ui/components/search.js'
import { renderTrending, setupTrendingHandlers } from './ui/components/trending.js'
import { renderSettings, setupSettingsHandlers, initSettings } from './ui/components/settings.js'
import { initNotifications, updateNotificationsBadge, renderNotifications } from './ui/components/notifications.js'
import { initColumnResize } from './ui/components/column-resize.js'
import * as wallet from './lib/wallet.js'
import { DM } from './lib/dm.js'
import { Discovery } from './lib/discovery.js'
import { SupporterManager, getSupporterManager } from './lib/supporter-manager.js'
import { SyncClient } from './lib/sync-client.js'
import * as paywall from './lib/paywall.js'
import * as paywallStorage from './lib/paywall-storage.js'
import { deriveLocalStorageKey } from './lib/dm-crypto.js'

// Official Swarmnero account - new users auto-follow this account
const OFFICIAL_SWARM_ID = '9aa8bf64357d4db09ea62aa6ddd771affc161d43624e3d162e1d115af5503e74'
// Previous official Swarmnero account (rotated 2026-04-20). Existing users
// still following this will be migrated to the new key on next login.
const LEGACY_OFFICIAL_SWARM_IDS = [
  '5f5ef421cd609b2d98d8ef3d11eb53bfb623ac3d8126e4189b1aaead1298ee52'
]

// Data directory - Pear provides app storage path
const DATA_DIR = Pear.config.storage || './data'

// Configure wallet module to use the same data directory
wallet.setDataDir(DATA_DIR)

// Configure paywall storage
paywallStorage.setDataDir(DATA_DIR)

// Initialize Supporter Manager
const supporterManager = getSupporterManager()
supporterManager.setDataDir(DATA_DIR)
supporterManager.loadListings()
state.supporterManager = supporterManager
console.log('[App] Supporter Manager initialized')

// One-time migration: clear old discovery cache (Supporter v2)
const supporterMigrationKey = 'supporter_v2_migration_done'
if (!localStorage.getItem(supporterMigrationKey)) {
  console.log('[App] Migrating to Supporter v2 - clearing old discovery cache')
  // Clear the discovery cache if it exists
  if (state.discovery) {
    state.discovery.clearCache?.()
  }
  localStorage.setItem(supporterMigrationKey, 'true')
}

// Navigation button handling - shows sections in right panel
function initNavButtons() {
  const navBtns = document.querySelectorAll('.nav-btn')

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view

      // Toggle active state
      const isActive = btn.classList.contains('active')

      // Remove active from all buttons
      navBtns.forEach(b => b.classList.remove('active'))

      // If wasn't active, show this section in right panel
      if (!isActive) {
        btn.classList.add('active')
        showSection(view)
      } else {
        // Was active, hide and show empty
        hideAllSections()
      }
    })
  })
}

// Copy Swarm ID handler
function initCopySwarmId() {
  dom.copySwarmIdBtn.addEventListener('click', async () => {
    if (!state.feed?.swarmId) return
    try {
      await navigator.clipboard.writeText(state.feed.swarmId)
      dom.copySwarmIdBtn.textContent = 'Copied!'
      dom.copySwarmIdBtn.classList.add('copied')
      setTimeout(() => {
        dom.copySwarmIdBtn.textContent = 'Copy My ID'
        dom.copySwarmIdBtn.classList.remove('copied')
      }, 2000)
    } catch (err) {
      console.error('Copy failed:', err)
    }
  })
}

// Quick follow handler (in My ID section)
function initQuickFollow() {
  if (!dom.quickFollowBtn || !dom.quickFollowInput) return

  dom.quickFollowBtn.addEventListener('click', async () => {
    const input = dom.quickFollowInput.value.trim()
    if (!input) return

    const swarmId = parseSwarmId(input)
    if (!swarmId) {
      alert('Invalid Swarm ID. Paste a valid 64-character hex ID.')
      return
    }

    // Check if already following
    if (state.feed?.peers?.has(swarmId)) {
      alert('You are already following this user.')
      dom.quickFollowInput.value = ''
      return
    }

    dom.quickFollowBtn.disabled = true
    dom.quickFollowBtn.textContent = 'Following...'

    try {
      await state.feed.append(createFollowEvent({ swarmId }))
      await state.feed.follow(swarmId)
      dom.quickFollowInput.value = ''
      dom.quickFollowBtn.textContent = 'Followed!'

      // Refresh UI to show new user's posts
      await refreshUI()

      setTimeout(() => {
        dom.quickFollowBtn.textContent = 'Follow'
        dom.quickFollowBtn.disabled = false
      }, 2000)
    } catch (err) {
      console.error('Quick follow failed:', err)
      alert('Error following: ' + err.message)
      dom.quickFollowBtn.textContent = 'Follow'
      dom.quickFollowBtn.disabled = false
    }
  })

  // Allow Enter key to submit
  dom.quickFollowInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      dom.quickFollowBtn.click()
    }
  })
}

// "My posts" timeline toggle
function initTimelineToggle(refreshUI) {
  if (!dom.myPostsToggleBtn) return
  dom.myPostsToggleBtn.addEventListener('click', async () => {
    state.showMyPostsOnly = !state.showMyPostsOnly
    state.timelineVisibleCount = state.timelinePageSize
    dom.myPostsToggleBtn.classList.toggle('active', state.showMyPostsOnly)
    dom.myPostsToggleBtn.setAttribute('aria-pressed', state.showMyPostsOnly ? 'true' : 'false')
    await refreshUI()
  })
}

// Store timeline for panel access
let currentTimeline = []

// Flag to prevent duplicate event handlers
let handlersInitialized = false

// Menu bar handlers
function initMenuBar() {
  // Close app
  document.getElementById('menuClose').addEventListener('click', () => {
    Pear.exit()
  })

  // File > New Post
  document.getElementById('menuNewPost')?.addEventListener('click', () => {
    showExpandedComposer()
  })

  // File > Logout
  document.getElementById('menuLogout')?.addEventListener('click', () => {
    dom.logoutBtn?.click()
  })

  // View > Timeline
  document.getElementById('menuTimeline')?.addEventListener('click', () => {
    hideAllSections()
  })

  // View > Profile
  document.getElementById('menuProfile')?.addEventListener('click', () => {
    showSection('profile')
  })

  // View > Following
  document.getElementById('menuFollowing')?.addEventListener('click', () => {
    showSection('follow')
  })

  // View > Messages
  document.getElementById('menuMessages')?.addEventListener('click', () => {
    showSection('messages')
  })

  // Wallet > Open Wallet
  document.getElementById('menuWallet')?.addEventListener('click', () => {
    pushPanel('wallet')
  })

  // Help > Getting Started
  document.getElementById('menuGettingStarted')?.addEventListener('click', () => {
    showHelpModal('getting-started')
  })

  // Help > Tipping Guide
  document.getElementById('menuTippingGuide')?.addEventListener('click', () => {
    showHelpModal('tipping-guide')
  })

  // Help > About
  document.getElementById('menuAbout')?.addEventListener('click', () => {
    showSection('about')
  })

  // Help modal close button
  document.getElementById('helpClose')?.addEventListener('click', () => {
    document.getElementById('helpModal')?.classList.add('hidden')
  })
}

// Help content
const helpContent = {
  'getting-started': {
    title: 'Getting Started',
    content: `
      <h4>Welcome to Swarmnero</h4>
      <p>Swarmnero is a decentralized social network with built-in Monero payments. Your posts and interactions are stored on a peer-to-peer network - no central servers.</p>

      <h4>Creating Your Identity</h4>
      <p>When you first launch Swarmnero, you'll create an account. This generates a unique cryptographic identity (keypair) stored locally on your device.</p>

      <div class="tip-box">
        <div class="tip-label">💡 Important</div>
        <p>Your identity is stored locally. If you clear your data, you'll need your Secret Key to restore access.</p>
      </div>

      <h4>Following Others</h4>
      <p>To see posts from other users:</p>
      <ul>
        <li>Get their <strong>Swarm ID</strong> (a long hex string)</li>
        <li>Click "Following" in the left nav</li>
        <li>Paste the Swarm ID and click "Follow"</li>
      </ul>
      <p>Their posts will appear in your timeline once connected.</p>

      <h4>Sharing Your Swarm ID</h4>
      <p>Your Swarm ID is shown in the right panel. Share this with others so they can follow you. Click the copy button to copy it to your clipboard.</p>
    `
  },
  'tipping-guide': {
    title: 'Tipping Guide',
    content: `
      <h4>Sending Tips</h4>
      <p>You can send Monero tips to posts by clicking the Monero icon. You'll need:</p>
      <ul>
        <li>A wallet created or restored in Swarmnero</li>
        <li>Your wallet unlocked with your password</li>
        <li>Sufficient XMR balance</li>
      </ul>

      <h4>Receiving Tips</h4>
      <p>To receive tips on your posts, create or restore a Monero wallet in the Wallet panel.</p>

      <div class="tip-box">
        <div class="tip-label">💡 Important</div>
        <p><strong>Unlock your wallet BEFORE creating posts</strong> to enable tip tracking. When your wallet is unlocked, each post gets a unique subaddress that lets you see exactly which post was tipped.</p>
      </div>

      <h4>Tracking Tips</h4>
      <p>For posts created with wallet unlocked:</p>
      <ul>
        <li>Your wallet can link incoming tips to specific posts</li>
        <li>Click a transaction in your wallet to see "View Post"</li>
        <li>The post will show tip counts and amounts received</li>
      </ul>

      <h4>Tips You've Sent</h4>
      <p>When you send a tip, Swarmnero remembers which post you tipped. Click any outgoing tip transaction to see "View Post" and revisit the content you supported.</p>

      <h4>If Wallet Was Locked</h4>
      <p>Posts created when wallet was locked use your main Monero address. You'll still receive tips, but Swarmnero can't automatically link them to specific posts.</p>
    `
  }
}

/**
 * Index own posts and followed posts for search on startup
 * @param {Feed} feed - The feed instance
 * @param {TagIndex} tagIndex - The tag index instance
 */
async function indexStartupPosts(feed, tagIndex) {
  try {
    console.log('[App] Indexing posts for search...')
    let totalIndexed = 0

    // Index own posts
    const ownEvents = await feed.read()
    const ownPosts = ownEvents.filter(e => e.type === 'post' && e.tags && e.tags.length > 0)
    if (ownPosts.length > 0) {
      const ownCount = tagIndex.indexPostsBatch(ownPosts, 'own')
      totalIndexed += ownCount
      console.log(`[App] Indexed ${ownCount} own posts with tags`)
    }

    // Index posts from followed users in parallel
    const following = feed.getFollowing()
    const peerResults = await Promise.all(
      following.map(async (swarmId) => {
        try {
          const peerEvents = await feed.readPeer(swarmId)
          return peerEvents.filter(e => e.type === 'post' && e.tags && e.tags.length > 0)
        } catch (err) {
          console.warn(`[App] Error indexing posts from ${swarmId.slice(0, 8)}...:`, err.message)
          return []
        }
      })
    )

    // Batch index all peer posts
    for (const peerPosts of peerResults) {
      if (peerPosts.length > 0) {
        const peerCount = tagIndex.indexPostsBatch(peerPosts, 'following')
        totalIndexed += peerCount
      }
    }

    console.log(`[App] Startup indexing complete: ${totalIndexed} posts indexed`)
  } catch (err) {
    console.error('[App] Error during startup indexing:', err.message)
  }
}

/**
 * Show wallet unlock prompt after login if wallet exists
 * Asks user if they want to unlock their wallet
 */
async function showLoginWalletPrompt() {
  const accountName = state.activeAccountName
  if (!accountName) return

  // Check if wallet exists for this account
  const hasWalletForAccount = await wallet.hasWallet(accountName)
  if (!hasWalletForAccount) return

  // Check if wallet is already unlocked (shouldn't be, but just in case)
  if (wallet.isWalletUnlocked()) return

  // Show the prompt modal
  const modal = document.getElementById('loginWalletPromptModal')
  const passwordInput = document.getElementById('loginWalletPassword')
  const errorEl = document.getElementById('loginWalletError')
  const unlockBtn = document.getElementById('loginWalletUnlock')
  const skipBtn = document.getElementById('loginWalletSkip')

  if (!modal || !passwordInput) return

  // Reset state
  passwordInput.value = ''
  errorEl.classList.add('hidden')
  errorEl.textContent = ''
  unlockBtn.disabled = false
  unlockBtn.textContent = 'Unlock'

  modal.classList.remove('hidden')
  passwordInput.focus()

  // Handle unlock
  const handleUnlock = async () => {
    const password = passwordInput.value
    if (!password) {
      errorEl.textContent = 'Please enter your password'
      errorEl.classList.remove('hidden')
      return
    }

    unlockBtn.disabled = true
    unlockBtn.textContent = 'Unlocking...'
    errorEl.classList.add('hidden')

    try {
      await wallet.unlock(accountName, password)
      state.walletUnlocked = true

      // Update profile with a fresh subaddress for improved privacy
      await updateProfileWithNewSubaddress()

      // Start background sync
      wallet.startBackgroundSync()

      // Close modal
      modal.classList.add('hidden')
      passwordInput.value = ''

      console.log('[App] Wallet unlocked on login')
    } catch (e) {
      errorEl.textContent = 'Invalid password'
      errorEl.classList.remove('hidden')
      unlockBtn.disabled = false
      unlockBtn.textContent = 'Unlock'
    }
  }

  // Handle skip
  const handleSkip = () => {
    modal.classList.add('hidden')
    passwordInput.value = ''
    console.log('[App] User skipped wallet unlock on login')
  }

  // Remove old event listeners and add new ones
  const newUnlockBtn = unlockBtn.cloneNode(true)
  const newSkipBtn = skipBtn.cloneNode(true)
  unlockBtn.parentNode.replaceChild(newUnlockBtn, unlockBtn)
  skipBtn.parentNode.replaceChild(newSkipBtn, skipBtn)

  newUnlockBtn.addEventListener('click', handleUnlock)
  newSkipBtn.addEventListener('click', handleSkip)

  // Handle Enter key
  passwordInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      handleUnlock()
    }
  }
}

/**
 * Show the help modal with specified content
 */
// Warn that another live instance of the same account is online. Hypercore
// is single-writer, so two instances can collide and lock the feed. Shown
// at most once per session; clicking the × dismisses it (not persistent —
// reappears on relaunch if still applicable).
function showDuplicateInstanceBanner() {
  if (document.getElementById('duplicateInstanceBanner')) return
  const banner = document.createElement('div')
  banner.id = 'duplicateInstanceBanner'
  banner.className = 'duplicate-instance-banner'
  banner.innerHTML = `
    <div class="dib-inner">
      <strong>⚠ This account is signed in on another device.</strong>
      <span> Swarmnero feeds are single-writer — posting from two places at once can lock your feed. Sign out elsewhere to continue safely.</span>
      <button class="dib-close" aria-label="Dismiss">×</button>
    </div>
  `
  banner.querySelector('.dib-close').addEventListener('click', () => banner.remove())
  document.body.appendChild(banner)
  console.warn('[App] Duplicate instance of this account detected on the network')
}

// Append the running Pear release length to the header version badge.
// Silently falls back to the hardcoded version string if Pear APIs are
// unavailable (e.g. when loaded outside Pear Runtime).
async function appendReleaseLengthToVersion() {
  try {
    if (typeof Pear === 'undefined' || typeof Pear.versions !== 'function') return
    const v = await Pear.versions()
    const length = v?.app?.length
    const el = document.getElementById('versionBadge')
    if (el && length) {
      el.textContent = `${el.textContent} (${length})`
    }
  } catch (err) {
    console.warn('[App] appendReleaseLengthToVersion:', err)
  }
}

// Pear fetches new releases in the background and caches them, but only
// applies the new version on the next launch. Listen for update-ready events
// and show a banner with a Restart button so users can pick up the update
// without waiting for a future relaunch.
function initUpdateListener() {
  if (typeof Pear === 'undefined' || typeof Pear.updates !== 'function') return
  try {
    const stream = Pear.updates()
    stream.on('data', (info) => {
      console.log('[App] Update ready:', info)
      showUpdateReadyBanner()
    })
    stream.on('error', (err) => console.warn('[App] Pear.updates error:', err))
  } catch (err) {
    console.warn('[App] Pear.updates unavailable:', err)
  }
}

function showUpdateReadyBanner() {
  if (document.getElementById('updateReadyBanner')) return
  const banner = document.createElement('div')
  banner.id = 'updateReadyBanner'
  banner.className = 'update-ready-banner'
  banner.innerHTML = `
    <div class="urb-inner">
      <strong>↻ Update ready</strong>
      <span>A new version of Swarmnero is downloaded. Restart to apply.</span>
      <button class="urb-restart">Restart now</button>
      <button class="urb-close" aria-label="Dismiss later">×</button>
    </div>
  `
  banner.querySelector('.urb-restart').addEventListener('click', () => {
    try {
      Pear.restart()
    } catch (err) {
      console.error('[App] Pear.restart failed:', err)
      alert('Could not restart automatically. Please close and relaunch Swarmnero.')
    }
  })
  banner.querySelector('.urb-close').addEventListener('click', () => banner.remove())
  document.body.appendChild(banner)
}

function showHelpModal(type) {
  const modal = document.getElementById('helpModal')
  const titleEl = document.getElementById('helpTitle')
  const contentEl = document.getElementById('helpContent')

  if (!modal || !titleEl || !contentEl) return

  const content = helpContent[type]
  if (!content) return

  titleEl.textContent = content.title
  contentEl.innerHTML = content.content

  modal.classList.remove('hidden')
}

// Refresh UI with latest data
async function refreshUI() {
  if (!state.feed || !state.identity) return
  try {
    // Update wallet state
    state.walletUnlocked = wallet.isWalletUnlocked()

    // Update Swarm ID display (truncated with tooltip)
    const swarmId = state.feed.swarmId
    if (swarmId) {
      dom.swarmIdEl.textContent = `${swarmId.slice(0, 8)}...${swarmId.slice(-8)}`
      dom.swarmIdEl.title = swarmId // Full ID on hover
    } else {
      dom.swarmIdEl.textContent = '-'
      dom.swarmIdEl.title = ''
    }

    // Get our profile
    const events = await state.feed.read()
    state.myProfile = getLatestProfile(events)
    await updateProfileForm()
    renderAccountDropdown() // Update dropdown with profile name
    updateDiscoveryProfile() // Keep discovery profile in sync

    // Load user's existing discovery profile from feed
    const existingDiscoveryProfile = getLatestDiscoveryProfile(events)
    if (existingDiscoveryProfile && state.discovery) {
      state.discovery.setMyDiscoveryProfile(existingDiscoveryProfile)
    }

    // Get peer profiles, swarm ID mapping, and supporter listings
    const { profiles, swarmIdToPubkey, pubkeyToSwarmId, supporterListings } = await state.feed.getPeerProfiles()
    state.peerProfiles = profiles
    // Store on feed for FoF access
    state.feed.peerProfiles = profiles
    state.feed.myProfile = state.myProfile
    state.feed.pubkeyToSwarmId = pubkeyToSwarmId
    // Add our own swarm ID to pubkey mapping (needed for tips on our own posts)
    swarmIdToPubkey[state.feed.swarmId] = state.identity.pubkeyHex
    state.swarmIdToPubkey = swarmIdToPubkey
    state.pubkeyToSwarmId = pubkeyToSwarmId

    // Add peer supporter listings to the directory (P2P sync)
    if (supporterListings && Object.keys(supporterListings).length > 0) {
      const supporterManager = getSupporterManager()
      supporterManager.addPeerListings(supporterListings, profiles)
    }

    // Update DM system with pubkey-to-swarmId mapping for mutual follow checks
    if (state.dm) {
      state.dm.setPubkeyToSwarmId(pubkeyToSwarmId)
    }

    // Get timeline and count tips (using new function with deduplication)
    currentTimeline = await state.feed.getTimeline()
    const myPubkey = state.identity.pubkeyHex
    state.tipsByPost = countTipsForPost(currentTimeline, state.swarmIdToPubkey, myPubkey)

    // Build subaddress to post mapping for wallet transaction linking
    state.subaddressToPost = buildSubaddressToPostMap(currentTimeline, myPubkey)

    renderPosts(currentTimeline, refreshUI)

    // Count only MY posts (excluding deleted)
    const deletedTimestamps = new Set(
      currentTimeline.filter(e => e.type === 'delete' && e.pubkey === myPubkey).map(e => e.post_timestamp)
    )
    const postCount = currentTimeline.filter(e =>
      e.type === 'post' && e.pubkey === myPubkey && !deletedTimestamps.has(e.timestamp)
    ).length
    dom.feedLengthEl.textContent = postCount

    // Peer count
    const peerCount = state.feed.peerCount
    const peerLabel = peerCount === 1 ? 'peer' : 'peers'
    dom.peerCountEl.textContent = peerCount
    dom.headerPeerCountEl.textContent = `${peerCount} ${peerLabel}`

    // Following list
    renderFollowing(state.feed.getFollowing(), refreshUI)

    // Feed stats to Discovery for hello messages
    if (state.discovery) {
      const followingStats = state.feed.getFollowing().map(sid => ({
        swarmId: sid,
        name: state.peerProfiles?.[state.swarmIdToPubkey?.[sid]]?.name || null
      }))
      const followerStats = Array.from(state.feed.followers || []).map(sid => ({
        swarmId: sid,
        name: state.peerProfiles?.[state.swarmIdToPubkey?.[sid]]?.name || null
      }))
      state.discovery.setStats({
        postCount,
        following: followingStats,
        followers: followerStats
      })
    }

    // Update notifications badge
    updateNotificationsBadge()

    // Update header sync status indicator
    renderHeaderSyncStatus()

  } catch (err) {
    console.error('Error refreshing UI:', err)
  }
}

/**
 * Detect and announce incoming tips via tip_received events
 * Called after wallet sync completes to check for new tips
 */
async function announceReceivedTips() {
  try {
    if (!wallet.isWalletUnlocked()) {
      return
    }

    // Get tips - either linked to specific posts, or all incoming if no post mapping
    let incomingTips = []
    if (state.subaddressToPost && state.subaddressToPost.size > 0) {
      // Try to get tips linked to specific posts first
      incomingTips = await wallet.getIncomingTipsForPosts(state.subaddressToPost)
    }

    // If no post-specific tips found, check for any incoming tips (e.g., tips to profile address)
    if (incomingTips.length === 0) {
      incomingTips = await wallet.getAllIncomingTips()
    }

    if (incomingTips.length === 0) {
      return
    }

    console.log('[App] Found', incomingTips.length, 'incoming tips to announce')

    // Show toast notification for incoming tips
    const totalAmount = incomingTips.reduce((sum, tip) => sum + tip.amount, 0n)
    const amountStr = wallet.formatXMR(totalAmount)
    if (incomingTips.length === 1) {
      showToast('Tip Received!', `You received ${amountStr} XMR`, 'success')
    } else {
      showToast('Tips Received!', `You received ${amountStr} XMR across ${incomingTips.length} posts`, 'success')
    }

    // Add to tip notifications for the Notifications panel
    for (const tip of incomingTips) {
      state.tipNotifications.push({
        id: `tip-${tip.txid}`,
        amount: wallet.formatXMR(tip.amount),
        postTimestamp: tip.postTimestamp,
        txid: tip.txid,
        receivedAt: Date.now(),
        dismissed: false
      })
    }
    // Update notifications badge
    const { updateNotificationsBadge } = await import('./ui/components/notifications.js')
    updateNotificationsBadge()

    // Announce each tip via a tip_received event
    for (const tip of incomingTips) {
      try {
        // Create tip_received event
        // Note: We don't know who sent the tip (Monero is private), so from_pubkey is 'unknown'
        // tx_proof intentionally not included for privacy
        const event = createTipReceivedEvent({
          postTimestamp: tip.postTimestamp,
          fromPubkey: 'unknown',  // Monero doesn't reveal sender
          amount: wallet.formatXMR(tip.amount)
          // tx_proof removed for privacy - no longer broadcast
        })

        await state.feed.append(event)

        // Mark as announced to avoid re-announcing
        wallet.markTipAnnounced(tip.txid)

        console.log('[App] Announced tip for post timestamp:', tip.postTimestamp, 'amount:', wallet.formatXMR(tip.amount))
      } catch (err) {
        console.error('[App] Error announcing tip:', err.message)
      }
    }

    // Refresh UI to show updated tip counts
    await refreshUI()
  } catch (err) {
    console.error('[App] Error in announceReceivedTips:', err.message)
  }
}

// Handle author click - show profile in right panel (uses navigation stack)
function handleAuthorClick(pubkey, timeline) {
  pushPanel('profile', { pubkey, timeline })
}

// Handle thread click - show thread in right panel (uses navigation stack)
function handleThreadClick(pubkey, timestamp, focusReply) {
  pushPanel('thread', { pubkey, timestamp, focusReply })
}

// Initialize the app
async function init() {
  try {
    console.log('Swarmnero starting...')
    console.log('Data directory:', DATA_DIR)

    // Initialize DOM references
    initDom()

    // Append the Pear release length to the version badge so we can confirm
    // which release is running (e.g. "v0.8.17 (4219)").
    appendReleaseLengthToVersion()

    // Start listening for Pear release updates so we can prompt the user to
    // restart when a new version has been downloaded.
    initUpdateListener()

    // Initialize account manager (handles multi-account and encryption)
    const accountManager = new AccountManager(DATA_DIR)
    await accountManager.load()

    // Store in state
    state.accountManager = accountManager
    state.accounts = accountManager.accounts
    state.activeAccountName = accountManager.activeAccount

    // Always show welcome screen on startup
    showWelcomeScreen()

  } catch (err) {
    console.error('Init error:', err)
  }
}

// Show welcome screen with account options
function showWelcomeScreen() {
  const welcomeScreen = document.getElementById('welcomeScreen')
  const existingAccounts = document.getElementById('existingAccounts')
  const accountsList = document.getElementById('welcomeAccountsList')
  const defaultAccountHint = document.getElementById('defaultAccountHint')

  if (!welcomeScreen) return

  // Render existing accounts
  const accounts = state.accounts || []
  if (accounts.length > 0) {
    existingAccounts.classList.add('has-accounts')

    // Show hint if there's only a default account without a profile name set
    const hasOnlyDefault = accounts.length === 1 && accounts[0].name === 'default'
    const defaultHasNoProfile = hasOnlyDefault && !accounts[0].profileName
    if (defaultAccountHint) {
      defaultAccountHint.style.display = defaultHasNoProfile ? 'block' : 'none'
    }

    accountsList.innerHTML = accounts.map(acc => {
      // Use cached profile name if available, otherwise fall back to account name
      const displayName = acc.profileName || acc.name
      const avatarLetter = displayName.charAt(0).toUpperCase()
      return `
        <button class="welcome-account-btn" data-account="${acc.name}" data-encrypted="${acc.encrypted}">
          <span class="account-avatar">${avatarLetter}</span>
          <div class="welcome-account-info">
            <span class="welcome-account-name">${displayName}</span>
            <span class="welcome-account-id">${acc.pubkeyHex.slice(0, 16)}...</span>
          </div>
          ${acc.encrypted ? '<span class="lock-icon">&#128274;</span>' : ''}
        </button>
      `
    }).join('')

    // Bind click handlers for account buttons
    accountsList.querySelectorAll('.welcome-account-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.account
        const encrypted = btn.dataset.encrypted === 'true'

        if (encrypted) {
          showWelcomePasswordModal(name)
        } else {
          await loginToAccount(name)
        }
      })
    })
  }

  // Bind import account handler
  const importBtn = document.getElementById('importAccountBtn')
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const secretKey = document.getElementById('importSecretKey').value.trim()
      const name = document.getElementById('importAccountName').value.trim()

      if (!secretKey) {
        alert('Please enter a Secret Key')
        return
      }
      if (!name) {
        alert('Please enter an account name')
        return
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        alert('Account name can only contain letters, numbers, underscores, and hyphens')
        return
      }

      importBtn.disabled = true
      try {
        await state.accountManager.importAccount(name, secretKey)
        state.accounts = state.accountManager.accounts
        await loginToAccount(name)
      } catch (err) {
        alert('Import failed: ' + err.message)
        importBtn.disabled = false
      }
    })
  }

  // Bind create new account handler
  const createBtn = document.getElementById('createFirstAccountBtn')
  const newAccountInput = document.getElementById('newAccountNameWelcome')
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const name = newAccountInput?.value.trim() || 'default'

      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        alert('Account name can only contain letters, numbers, underscores, and hyphens')
        return
      }

      createBtn.disabled = true
      try {
        await state.accountManager.createAccount(name)
        state.accounts = state.accountManager.accounts
        await loginToAccount(name)
      } catch (err) {
        alert('Error creating account: ' + err.message)
        createBtn.disabled = false
      }
    })
  }

  welcomeScreen.classList.remove('hidden')
}

// Show password modal for encrypted account on welcome screen
function showWelcomePasswordModal(accountName) {
  if (!dom.loginModal) return

  dom.loginModal.classList.remove('hidden')
  dom.loginModal.dataset.account = accountName
  dom.passwordInput.value = ''
  dom.passwordInput.focus()

  const loginSubmit = document.getElementById('loginSubmit')
  const loginCancel = document.getElementById('loginCancel')

  const handleLogin = async () => {
    const password = dom.passwordInput.value
    if (!password) {
      alert('Please enter a password')
      return
    }

    loginSubmit.disabled = true
    try {
      await state.accountManager.switchAccount(accountName, password)
      dom.loginModal.classList.add('hidden')
      await loginToAccount(accountName, true) // Already switched, skip switch
    } catch (err) {
      alert('Invalid password')
    }
    loginSubmit.disabled = false
  }

  const handleCancel = () => {
    dom.loginModal.classList.add('hidden')
    dom.passwordInput.onkeydown = null // Clean up
  }

  // Replace handlers
  loginSubmit.onclick = handleLogin
  loginCancel.onclick = handleCancel

  // Enter key support
  dom.passwordInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      handleLogin()
    }
  }
}

// Login to account and start the app
async function loginToAccount(name, alreadySwitched = false) {
  const welcomeScreen = document.getElementById('welcomeScreen')

  try {
    if (!alreadySwitched) {
      await state.accountManager.switchAccount(name)
    }
    state.activeAccountName = state.accountManager.activeAccount

    // Hide welcome screen, show app
    if (welcomeScreen) {
      welcomeScreen.classList.add('hidden')
    }
    document.getElementById('appLayout').classList.remove('hidden')
    document.querySelector('header').classList.remove('hidden')

    // Continue initialization
    await continueInit(state.accountManager)
  } catch (err) {
    alert('Error logging in: ' + err.message)
  }
}

// Continue initialization after identity is loaded
async function continueInit(accountManager) {
  const identity = accountManager.currentIdentity
  console.log('Identity loaded:', identity.pubkeyHex.slice(0, 16) + '...')

  // Set paywall storage encryption key (encrypts paywall-keys.json at rest)
  paywallStorage.setEncryptionKey(deriveLocalStorageKey(identity.secretKey))

  // Initialize feed with P2P
  const feed = new Feed(DATA_DIR, identity)
  feed.onPeerUpdate = () => {
    const count = feed.peerCount
    const label = count === 1 ? 'peer' : 'peers'
    dom.peerCountEl.textContent = count
    dom.headerPeerCountEl.textContent = `${count} ${label}`
  }
  // Event-driven refresh instead of polling
  feed.onDataUpdate = () => scheduleRefresh(refreshUI)
  // One-time keypair extraction on legacy accounts — persist so the
  // feed's swarmId becomes portable across devices from now on.
  feed.onHypercoreKeyPairExtracted = async () => {
    try {
      await state.accountManager.persistHypercoreKeyPair()
      console.log('[App] Persisted hypercoreKeyPair for portable swarmId')
    } catch (err) {
      console.warn('[App] Could not persist hypercoreKeyPair:', err.message)
    }
  }
  await feed.init()
  // Mark sync server VPS as infrastructure so user protocols skip it
  // (must happen before FoF/DM/Discovery handlers attach)
  const { resolveSyncServerHost } = await import('./lib/sync-client.js')
  const syncHost = await resolveSyncServerHost()
  feed.markInfrastructureHost(syncHost)
  console.log('Feed initialized:', feed.swarmId.slice(0, 16) + '...')

  // Auto-follow official account for new users
  // Only if: 1) This is a new account (empty feed), 2) Not already following
  const isNewAccount = feed.length === 0
  const alreadyFollowing = feed.getFollowing().includes(OFFICIAL_SWARM_ID)
  if (isNewAccount && !alreadyFollowing && feed.swarmId !== OFFICIAL_SWARM_ID) {
    try {
      console.log('[App] New account detected, auto-following official account')
      await feed.append(createFollowEvent({ swarmId: OFFICIAL_SWARM_ID }))
      await feed.follow(OFFICIAL_SWARM_ID)
      console.log('[App] Auto-followed official account:', OFFICIAL_SWARM_ID.slice(0, 16) + '...')
    } catch (err) {
      console.error('[App] Error auto-following official account:', err.message)
    }
  } else if (!isNewAccount) {
    // Existing-account migration: if they still follow a retired official
    // account, unfollow it and follow the current one. Idempotent — runs once
    // per account once the migration completes.
    try {
      const following = feed.getFollowing()
      const staleOfficials = LEGACY_OFFICIAL_SWARM_IDS.filter(id => following.includes(id))
      const needsNewOfficial = !following.includes(OFFICIAL_SWARM_ID) && feed.swarmId !== OFFICIAL_SWARM_ID
      if (staleOfficials.length > 0 || needsNewOfficial) {
        console.log('[App] Migrating official account follow', { staleOfficials, needsNewOfficial })
        for (const stale of staleOfficials) {
          await feed.append(createUnfollowEvent({ swarmId: stale }))
          await feed.unfollow(stale)
        }
        if (needsNewOfficial) {
          await feed.append(createFollowEvent({ swarmId: OFFICIAL_SWARM_ID }))
          await feed.follow(OFFICIAL_SWARM_ID)
          console.log('[App] Auto-followed new official account:', OFFICIAL_SWARM_ID.slice(0, 16) + '...')
        }
      }
    } catch (err) {
      console.error('[App] Official account migration failed:', err.message)
    }
  }

  // Auto-save profile with account name for new accounts
  // This ensures posts show the username immediately without requiring manual profile save
  if (isNewAccount) {
    try {
      const accountName = accountManager.activeAccount
      console.log('[App] New account - auto-saving profile with name:', accountName)
      await feed.append(createProfileEvent({ name: accountName, swarmId: feed.swarmId }))
    } catch (err) {
      console.error('[App] Error auto-saving profile:', err.message)
    }
  }

  // Initialize media storage (Hyperdrive)
  const media = new Media(feed.store, feed.swarm)
  await media.init()
  console.log('Media initialized:', media.driveKey.slice(0, 16) + '...')

  // Store in state
  initState(identity, feed, media)

  // Reset timeline pagination for new account session
  resetTimelinePagination()

  // Initialize DM system
  const dm = new DM(feed.store, feed.swarm, identity)
  await dm.init(DATA_DIR, feed)
  state.dm = dm
  console.log('DM initialized')

  // Initialize Sync Client for supporters so the connection is warm before
  // the user opens "Enable Feed Backup". Gated by supporter status so we
  // don't load the server with connections from non-paying accounts.
  const syncClient = new SyncClient({ feed, identity })
  state.syncClient = syncClient
  const syncActive = localStorage.getItem('swarmnero_sync_active') === 'true'
  const isSupporter = supporterManager.isListed(identity.pubkeyHex)
  if (syncActive || isSupporter) {
    setTimeout(async () => {
      try {
        await syncClient.init()
      } catch (err) {
        console.warn('SyncClient init error:', err.message)
      }
    }, 8000)
    console.log('SyncClient scheduled (supporter)')
  } else {
    console.log('SyncClient idle (not a supporter)')
  }

  // Initialize Discovery system (enabled after startup completes)
  // Profile is set later by updateDiscoveryProfile() in refreshUI()
  const discovery = new Discovery(feed.swarm, identity)
  state.discovery = discovery
  state.discovery.setDataDir(DATA_DIR)
  state.discovery.setFeed(feed)
  state.discovery.onDuplicateInstance = () => showDuplicateInstanceBanner()
  console.log('Discovery initialized')

  // Initialize FoF (after feed is ready)
  const tagIndex = getTagIndex()
  tagIndex.setDataDir(DATA_DIR, identity.pubkeyHex)
  await tagIndex.load()

  const fofCache = new FoFCache(DATA_DIR, { pubkeyHex: identity.pubkeyHex })
  state.fofCache = fofCache
  state.tagIndex = tagIndex

  const fof = new FoF({ feed, fofCache, tagIndex, dataDir: DATA_DIR })
  await fof.init()
  state.fof = fof
  feed.setFoF(fof)
  console.log('FoF initialized')

  // Initialize TipBatcher for delayed tip broadcasts (privacy)
  const tipBatcher = new TipBatcher(feed, DATA_DIR)
  tipBatcher.init()
  state.tipBatcher = tipBatcher
  console.log('TipBatcher initialized')

  // Initialize ReplyNotify protocol
  const replyNotify = new ReplyNotify({
    feed,
    dataDir: DATA_DIR,
    onPendingReply: ({ pending, autoApproved, author, postTimestamp }) => {
      if (pending) {
        console.log('[App] New pending reply from', author?.name || 'unknown')
        updateNotificationsBadge()
      } else if (autoApproved) {
        console.log('[App] Auto-approved reply from', author?.name || 'unknown')
      }
      // Refresh UI to show new reply
      scheduleRefresh(refreshUI)
    }
  })
  await replyNotify.init()
  state.replyNotify = replyNotify
  feed.setReplyNotify(replyNotify)
  console.log('ReplyNotify initialized')

  // Load any previously-unlocked paywalled posts from our own feed (non-blocking)
  // Includes both buyer-side private_data unlocks and author-side own paywalled posts
  paywall.loadUnlockedFromFeed(feed, identity).then(() => {
    scheduleRefresh(refreshUI)
  }).catch(err => {
    console.warn('[Paywall] loadUnlockedFromFeed error:', err.message)
  })

  // Background scanners for paywall:
  //   - Author scanner: process unlock_request events targeting our posts (releases keys)
  //   - Buyer scanner: process key_release events targeting us (decrypts content)
  // Run every 5 seconds. Scanners are pure local work (read cached events + check wallet history).
  // The author scanner only does work if the wallet is unlocked.
  setInterval(async () => {
    try {
      await paywall.processIncomingUnlockRequests(feed, identity)
    } catch (err) {
      console.warn('[Paywall] Author scanner error:', err.message)
    }
  }, 5000)

  setInterval(async () => {
    try {
      const newUnlocks = await paywall.processIncomingKeyReleases(feed, identity)
      if (newUnlocks > 0) {
        scheduleRefresh(refreshUI)
      }
    } catch (err) {
      console.warn('[Paywall] Buyer scanner error:', err.message)
    }
  }, 5000)
  console.log('Paywall scanners started')

  // Index own posts and followed posts for search
  await indexStartupPosts(feed, tagIndex)

  // Initialize UI components
  initNavButtons()
  initColumnResize()
  initComposer(refreshUI)
  initProfile(refreshUI)
  initFollow(refreshUI)
  initCopySwarmId()
  initQuickFollow()
  initTimelineToggle(refreshUI)
  initPanel()
  initMenuBar()
  initAccounts()
  initWallet(refreshUI)
  initTip(refreshUI)
  initMessages(refreshUI)
  initDiscovery(refreshUI)
  setupDiscoveryCallbacks()
  initSearch(refreshUI)
  initSettings(refreshUI)
  initNotifications(refreshUI)

  // Register callback to check for and announce incoming tips after wallet sync
  wallet.onSyncComplete(async () => {
    await announceReceivedTips()
  })

  // Register callback to refresh wallet UI after background sync completes
  // This ensures balance and transaction history update automatically when new transactions are detected
  wallet.onSyncComplete(async () => {
    // Only re-render if wallet is unlocked and we have an active account
    if (wallet.isWalletUnlocked() && state.activeAccountName) {
      console.log('[App] Background sync complete, refreshing wallet panel')
      await renderWalletPanel()
    }
  })

  // Process pending supporter listings after wallet sync
  wallet.onSyncComplete(async () => {
    const supporterManager = getSupporterManager()
    const pending = supporterManager.getPendingListings()
    if (pending.size > 0) {
      console.log('[App] Processing', pending.size, 'pending supporter listings after wallet sync')
      // Verification will be handled by the UI when user reviews pending listings
    }
  })

  // Retry verification of peer supporter listings whose on-chain check failed
  // the first time (node hadn't seen the tx, network error, etc). Runs on
  // every background sync completion so listings self-heal as the wallet's
  // node catches up.
  wallet.onSyncComplete(async () => {
    try {
      const supporterManager = getSupporterManager()
      const verified = await supporterManager.retryUnverifiedListings()
      if (verified > 0) scheduleRefresh(refreshUI)
    } catch (e) {
      console.warn('[App] retryUnverifiedListings error:', e.message)
    }
  })

  // Set up wallet render callback for panel navigation
  setRenderWalletCallback(renderWalletPanel)

  // Only add these handlers once (they persist across account switches)
  if (!handlersInitialized) {
    handlersInitialized = true

    // Wallet nav button handler (uses navigation stack)
    dom.walletNavBtn.addEventListener('click', () => {
      pushPanel('wallet')
    })

    // Feed nav button handler - return to feed view
    const feedNavBtn = document.getElementById('feedNavBtn')
    if (feedNavBtn) {
      feedNavBtn.addEventListener('click', () => {
        hideAllSections()
      })
    }

    // Back to Feed buttons in center column sections
    const backBtns = ['searchBackBtn', 'trendingBackBtn', 'settingsBackBtn']
    backBtns.forEach(btnId => {
      const btn = document.getElementById(btnId)
      if (btn) {
        btn.addEventListener('click', () => {
          hideAllSections()
        })
      }
    })

    // Logout button handler - return to welcome screen
    dom.logoutBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to logout?')) return

    // Stop wallet sync if running
    const wallet = await import('./lib/wallet.js')
    wallet.stopBackgroundSync()

    // Stop sync status polling
    stopSyncStatusPolling()

    // Clear paywall unlock cache
    paywall.clearUnlockedState()

    // Disable discovery
    if (state.discovery) {
      try { state.discovery.disable() } catch (e) { console.warn('Discovery disable:', e) }
    }

    // Close FoF
    if (state.fof) {
      try { await state.fof.close() } catch (e) { console.warn('FoF close:', e) }
    }

    // Close TipBatcher (saves pending tips to disk)
    if (state.tipBatcher) {
      try { state.tipBatcher.destroy() } catch (e) { console.warn('TipBatcher destroy:', e) }
    }

    // Close ReplyNotify
    if (state.replyNotify) {
      try { await state.replyNotify.close() } catch (e) { console.warn('ReplyNotify close:', e) }
    }

    // Close SyncClient
    if (state.syncClient) {
      try { state.syncClient.close() } catch (e) { console.warn('SyncClient close:', e) }
    }

    // Close DM connections
    if (state.dm) {
      try { await state.dm.close() } catch (e) { console.warn('DM close:', e) }
    }

    // Hide DM chat if open
    hideDMChat()

    // Close feed/swarm connections
    if (state.feed) {
      try { await state.feed.close() } catch (e) { console.warn('Feed close:', e) }
    }
    if (state.media) {
      try { await state.media.close() } catch (e) { console.warn('Media close:', e) }
    }

    // Reset state
    state.feed = null
    state.media = null
    state.dm = null
    state.syncClient = null
    state.discovery = null
    state.fof = null
    state.fofCache = null
    state.tagIndex = null
    state.replyNotify = null
    state.tipBatcher = null
    state.identity = null
    state.myProfile = null
    state.peerProfiles = {}
    state.swarmIdToPubkey = {}
    state.currentTimeline = []
    state.walletUnlocked = false
    state.dmUnreadCounts = {}
    state.activeDMPubkey = null
    state.showMyPostsOnly = false
    if (dom.myPostsToggleBtn) {
      dom.myPostsToggleBtn.classList.remove('active')
      dom.myPostsToggleBtn.setAttribute('aria-pressed', 'false')
    }

    // Reset timeline pagination
    resetTimelinePagination()

    // Show welcome screen, hide app
    document.getElementById('welcomeScreen').classList.remove('hidden')
    document.getElementById('appLayout').classList.add('hidden')
    document.querySelector('header').classList.add('hidden')

    // Reload welcome screen
    showWelcomeScreen()
    })
  } // End of handlersInitialized check

  // Render account dropdown
  renderAccountDropdown()

  // Set up account switch handler
  setOnAccountSwitch(async () => {
    // Clear timeline immediately
    currentTimeline = []
    dom.postsEl.innerHTML = '<div class="empty"><div class="empty-icon">&#9203;</div>Switching account...</div>'

    // Lock wallet to clear all cached data (balance, tx history, etc.) from previous account
    // This prevents data from Account A leaking into Account B's wallet view
    const walletModule = await import('./lib/wallet.js')
    await walletModule.lock()

    // Hide DM chat if open
    hideDMChat()

    // Disable discovery before closing
    if (state.discovery) {
      try { state.discovery.disable() } catch (e) { console.warn('Discovery disable:', e) }
    }

    // Close FoF before closing feed
    if (state.fof) {
      try { await state.fof.close() } catch (e) { console.warn('FoF close:', e) }
    }

    // Close TipBatcher (saves pending tips to disk)
    if (state.tipBatcher) {
      try { state.tipBatcher.destroy() } catch (e) { console.warn('TipBatcher destroy:', e) }
    }

    // Close ReplyNotify before closing feed
    if (state.replyNotify) {
      try { await state.replyNotify.close() } catch (e) { console.warn('ReplyNotify close:', e) }
    }

    // Close existing DM, media, and feed (in order - DM and media depend on feed's store/swarm)
    if (state.dm) {
      try { await state.dm.close() } catch (e) { console.warn('DM close:', e) }
    }
    if (state.media) {
      try { await state.media.close() } catch (e) { console.warn('Media close:', e) }
    }
    if (state.feed) {
      try { await state.feed.close() } catch (e) { console.warn('Feed close:', e) }
    }

    // Clear paywall unlock cache (account switch)
    paywall.clearUnlockedState()

    // Stop sync status polling (will restart after switch)
    stopSyncStatusPolling()

    // Clear state references
    state.feed = null
    state.media = null
    state.dm = null
    state.discovery = null
    state.fof = null
    state.fofCache = null
    state.tagIndex = null
    state.replyNotify = null
    state.tipBatcher = null

    // Brief delay to allow file locks to release
    await new Promise(resolve => setTimeout(resolve, 500))

    // Reinitialize with new identity (with retry for lock issues)
    const newIdentity = state.accountManager.currentIdentity
    const newFeed = new Feed(DATA_DIR, newIdentity)
    newFeed.onPeerUpdate = () => {
      const count = newFeed.peerCount
      const label = count === 1 ? 'peer' : 'peers'
      dom.peerCountEl.textContent = count
      dom.headerPeerCountEl.textContent = `${count} ${label}`
    }
    newFeed.onDataUpdate = () => scheduleRefresh(refreshUI)
    newFeed.onHypercoreKeyPairExtracted = async () => {
      try {
        await state.accountManager.persistHypercoreKeyPair()
        console.log('[App] Persisted hypercoreKeyPair for portable swarmId')
      } catch (err) {
        console.warn('[App] Could not persist hypercoreKeyPair:', err.message)
      }
    }

    // Retry feed init with exponential backoff if lock issues occur
    let retries = 3
    let delay = 500
    while (retries > 0) {
      try {
        await newFeed.init()
        break
      } catch (err) {
        retries--
        if (retries === 0 || !err.message.includes('ELOCKED')) {
          throw err
        }
        console.warn(`Feed init failed (ELOCKED), retrying in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        delay *= 2
      }
    }

    // Mark sync server VPS as infrastructure so user protocols skip it
    const { resolveSyncServerHost: resolveSyncServerHost2 } = await import('./lib/sync-client.js')
    const syncHost2 = await resolveSyncServerHost2()
    newFeed.markInfrastructureHost(syncHost2)

    const newMedia = new Media(newFeed.store, newFeed.swarm)
    await newMedia.init()

    // Update state
    initState(newIdentity, newFeed, newMedia)

    // Reset wallet state for new account
    state.walletUnlocked = false

    // Reinitialize DM for new identity
    const newDM = new DM(newFeed.store, newFeed.swarm, newIdentity)
    await newDM.init(DATA_DIR, newFeed)
    state.dm = newDM
    state.dmUnreadCounts = {}
    state.activeDMPubkey = null

    // Reinitialize Discovery for new identity (enabled by default)
    const newDiscovery = new Discovery(newFeed.swarm, newIdentity)
    newDiscovery.onDuplicateInstance = () => showDuplicateInstanceBanner()
    state.discovery = newDiscovery
    state.discovery.setDataDir(DATA_DIR)
    state.discovery.setFeed(newFeed)
    setupDiscoveryCallbacks()

    // Reinitialize tag index and FoF cache with the new account's pubkey so
    // trending/search only reflect this account's own feed and replication.
    const newTagIndex = getTagIndex()
    newTagIndex.setDataDir(DATA_DIR, newIdentity.pubkeyHex)
    await newTagIndex.load()
    state.tagIndex = newTagIndex
    const newFoFCache = new FoFCache(DATA_DIR, { pubkeyHex: newIdentity.pubkeyHex })
    state.fofCache = newFoFCache
    const newFoF = new FoF({ feed: newFeed, fofCache: newFoFCache, tagIndex: newTagIndex, dataDir: DATA_DIR })
    await newFoF.init()
    state.fof = newFoF
    newFeed.setFoF(newFoF)

    // Update unread badge
    await updateUnreadBadge()

    // Refresh UI with new account's data
    await refreshUI()

    // Reload paywall unlocks for new account (non-blocking)
    paywall.loadUnlockedFromFeed(newFeed, newIdentity).then(() => {
      scheduleRefresh(refreshUI)
    }).catch(e => console.warn('Paywall reload:', e))

    // Restart sync status polling for new account
    startSyncStatusPolling()

    // Enable discovery after a delay to avoid slowing account switch
    setTimeout(() => {
      if (state.discovery) {
        state.discovery.setProfile(state.myProfile, newFeed.swarmId)
        state.discovery.enable()
        renderDiscovery()
      }
    }, 5000)

    // Re-render discovery panel
    renderDiscovery()
  })

  // Set up author click handler for timeline
  setOnAuthorClick(handleAuthorClick)

  // Set up thread click handler for timeline
  setOnThreadClick(handleThreadClick)

  // Set up refresh callback for panel interactions
  setRefreshCallback(refreshUI)

  // Set up refresh callback for timeline thread view
  setRefreshUICallback(refreshUI)

  // Update status
  dom.statusEl.classList.remove('connecting')
  dom.statusEl.classList.add('connected')

  // Enable buttons
  dom.saveProfileBtn.disabled = false
  dom.followBtn.disabled = false

  // Initial UI refresh
  await refreshUI()

  console.log('Swarmnero ready!')

  // Start sync status polling for header indicator (always runs for supporters)
  startSyncStatusPolling()

  // Enable discovery after startup to avoid slowing initial connection
  setTimeout(() => {
    if (state.discovery) {
      state.discovery.enable()
      console.log('Discovery enabled')
    }
  }, 5000)

  // Show wallet unlock prompt if user has a wallet
  await showLoginWalletPrompt()
}

// Handle Pear teardown
Pear.teardown(async () => {
  console.log('Shutting down...')
  if (state.discovery) state.discovery.disable()
  if (state.dm) await state.dm.close()
  if (state.media) await state.media.close()
  if (state.feed) await state.feed.close()
})

// Start the app
init()
