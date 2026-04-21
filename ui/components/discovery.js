/**
 * Discovery component - discover other users on the network
 * Includes Support Swarmnero - a paid supporter program where users can contribute
 * and earn a Supporter badge. Payment supports Swarmnero development.
 */

import { state, dom } from '../state.js'
import { escapeHtml, safeAvatarUrl } from '../utils/dom.js'
import { createFollowEvent, createDiscoveryProfileEvent, createSupporterListingEvent, getLatestDiscoveryProfile } from '../../lib/events.js'
import { suggestTags } from '../../lib/tag-extractor.js'
import { getSupporterManager, SWARMNERO_WALLET_ADDRESS, LISTING_FEE_USD } from '../../lib/supporter-manager.js'
import { getXMRPrice } from '../../lib/price.js'
import * as wallet from '../../lib/wallet.js'
import { pushPanel } from './panel.js'
import { showProfileInCenter } from './timeline.js'
import { runFeedBackupPurchase } from './feed-backup.js'

let refreshUICallback = null

// Local state for discovery component
let activeTab = 'live'          // 'live' or 'supporters'
let activeTagFilter = null      // Currently selected tag filter
let showSupportForm = false  // Whether the become-a-supporter form is visible
let selectedTags = []           // Tags selected for supporter listing
let suggestedTags = []          // Tags suggested from profile/posts

// Payment flow state
let paymentStep = 'form'        // 'form', 'payment', 'verify', 'success'
let listingFeeXMR = null        // Cached listing fee in XMR
let paymentTxHash = ''          // User-entered transaction hash
let paymentTxKey = ''           // User-entered transaction key
let paymentStatus = null        // 'pending', 'verified', 'failed'
let paymentError = null         // Error message if payment verification failed

/**
 * Render the discovery panel
 */
export function renderDiscovery() {
  const container = document.getElementById('discoveryList')
  const supporterContainer = document.getElementById('supporterList')
  if (!container) return

  const peers = state.discovery?.getPeers() || []
  const isEnabled = state.discovery?.isEnabled || false

  // Update toggle state
  const toggle = document.getElementById('discoveryToggle')
  if (toggle) {
    toggle.checked = isEnabled
  }

  // Update peer count in Live tab
  const liveCountEl = document.getElementById('discoveryLiveCount')
  if (liveCountEl) {
    liveCountEl.textContent = peers.length
  }

  // Update cached profiles count in Supporters tab
  const cachedProfiles = state.discovery?.getCachedProfiles?.() || []
  const supporterCountEl = document.getElementById('discoverySupporterCount')
  if (supporterCountEl) {
    supporterCountEl.textContent = cachedProfiles.length
  }

  // Setup tab click handlers
  setupTabHandlers()

  // Render appropriate content based on active tab
  if (activeTab === 'live') {
    renderLiveList(container, peers, isEnabled)
  } else {
    renderSupporterList(supporterContainer, cachedProfiles)
  }

  // Render popular tags section
  renderPopularTags(cachedProfiles)

  // Render become-a-supporter form if visible
  renderSupportForm()
}

/**
 * Setup tab click handlers
 */
function setupTabHandlers() {
  const liveTab = document.querySelector('.discovery-tab[data-tab="live"]')
  const supporterTab = document.querySelector('.discovery-tab[data-tab="supporters"]')
  const liveContent = document.getElementById('discoveryLiveTab')
  const supporterContent = document.getElementById('discoverySupporterTab')
  const liveHelp = document.getElementById('discovery-help-live')
  const supporterHelp = document.getElementById('discovery-help-supporters')

  if (liveTab && !liveTab.dataset.handlerAttached) {
    liveTab.dataset.handlerAttached = 'true'
    liveTab.addEventListener('click', () => {
      activeTab = 'live'
      liveTab.classList.add('active')
      supporterTab?.classList.remove('active')
      liveContent?.classList.remove('hidden')
      supporterContent?.classList.add('hidden')
      liveHelp?.classList.remove('hidden')
      supporterHelp?.classList.add('hidden')
      renderDiscovery()
    })
  }

  if (supporterTab && !supporterTab.dataset.handlerAttached) {
    supporterTab.dataset.handlerAttached = 'true'
    supporterTab.addEventListener('click', () => {
      activeTab = 'supporters'
      supporterTab.classList.add('active')
      liveTab?.classList.remove('active')
      liveContent?.classList.add('hidden')
      supporterContent?.classList.remove('hidden')
      liveHelp?.classList.add('hidden')
      supporterHelp?.classList.remove('hidden')
      renderDiscovery()
    })
  }

  // Set initial visibility based on active tab
  if (activeTab === 'live') {
    liveContent?.classList.remove('hidden')
    supporterContent?.classList.add('hidden')
    liveHelp?.classList.remove('hidden')
    supporterHelp?.classList.add('hidden')
  } else {
    liveContent?.classList.add('hidden')
    supporterContent?.classList.remove('hidden')
    liveHelp?.classList.add('hidden')
    supporterHelp?.classList.remove('hidden')
  }

  // Update tab active states
  if (liveTab) liveTab.classList.toggle('active', activeTab === 'live')
  if (supporterTab) supporterTab.classList.toggle('active', activeTab === 'supporters')
}

/**
 * Render the live peers list
 */
function renderLiveList(container, peers, isEnabled) {
  if (!isEnabled) {
    container.innerHTML = `
      <div class="discovery-disabled">
        <p>Discovery is disabled</p>
        <p class="hint">Enable discovery to find other users and let them find you</p>
      </div>
    `
    return
  }

  if (peers.length === 0) {
    container.innerHTML = `
      <div class="discovery-empty">
        <div class="discovery-searching">
          <span class="spinner"></span>
          <p>Looking for other users...</p>
        </div>
        <p class="hint">Users with discovery enabled will appear here</p>
      </div>
    `
    return
  }

  // Get list of already-followed swarm IDs
  const following = new Set(state.feed?.getFollowing() || [])

  container.innerHTML = peers.map(peer => {
    const name = peer.profile?.name || peer.swarmId.slice(0, 12) + '...'
    const bio = peer.profile?.bio || ''
    const safeAv = safeAvatarUrl(peer.profile?.avatar)
    const initial = name.charAt(0).toUpperCase()
    const isFollowing = following.has(peer.swarmId)
    const safeSid = escapeHtml(peer.swarmId || '')

    const avatarHtml = safeAv
      ? `<div class="discovery-avatar"><img src="${escapeHtml(safeAv)}" alt=""></div>`
      : `<div class="discovery-avatar">${escapeHtml(initial)}</div>`

    return `
      <div class="discovery-item" data-swarm-id="${safeSid}">
        ${avatarHtml}
        <div class="discovery-info">
          <span class="discovery-name">${escapeHtml(name)}</span>
          ${bio ? `<span class="discovery-bio">${escapeHtml(bio.slice(0, 100))}${bio.length > 100 ? '...' : ''}</span>` : ''}
        </div>
        ${isFollowing
          ? '<span class="discovery-following">Following</span>'
          : `<button class="discovery-follow-btn" data-swarm-id="${safeSid}">Follow</button>`
        }
      </div>
    `
  }).join('')

  // Add follow button handlers
  container.querySelectorAll('.discovery-follow-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const swarmId = btn.dataset.swarmId
      btn.disabled = true
      btn.textContent = '...'

      try {
        await state.feed.append(createFollowEvent({ swarmId }))
        await state.feed.follow(swarmId)
        if (refreshUICallback) await refreshUICallback()
        renderDiscovery() // Re-render to show "Following"
      } catch (err) {
        alert('Error following: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Follow'
      }
    })
  })

  // Add profile click handlers on avatar and name
  container.querySelectorAll('.discovery-item[data-swarm-id]').forEach(item => {
    const swarmId = item.dataset.swarmId
    const peer = peers.find(p => p.swarmId === swarmId)
    if (!peer) return

    const openProfile = (e) => {
      e.stopPropagation()
      showProfileInCenter({
        name: peer.profile?.name || null,
        bio: peer.profile?.bio || null,
        avatar: peer.profile?.avatar || null,
        website: peer.profile?.website || null,
        swarmId: peer.swarmId,
        pubkey: peer.pubkey || null,
        postCount: peer.postCount || 0,
        following: peer.following || [],
        followers: peer.followers || []
      })
    }

    const avatar = item.querySelector('.discovery-avatar')
    if (avatar) {
      avatar.style.cursor = 'pointer'
      avatar.addEventListener('click', openProfile)
    }

    const infoArea = item.querySelector('.discovery-info')
    if (infoArea) {
      infoArea.style.cursor = 'pointer'
      infoArea.addEventListener('click', openProfile)
    }
  })
}

/**
 * Render the supporter list (cached profiles)
 * Now uses SupporterManager for verified paid listings
 */
function renderSupporterList(container, cachedProfiles) {
  if (!container) return

  // Get verified listings from SupporterManager
  const listingManager = getSupporterManager()
  const verifiedListings = listingManager.getVerifiedListings(
    activeTagFilter ? { tag: activeTagFilter } : {}
  )

  // Also include cached profiles that don't have verified listings (legacy support)
  // Filter by tag if active
  let filteredProfiles = cachedProfiles.filter(profile => {
    // Skip if this profile has a verified listing (we'll show that instead)
    if (listingManager.isListed(profile.pubkey)) {
      return false
    }
    if (activeTagFilter) {
      const tags = profile.discoveryProfile?.tags || []
      return tags.includes(activeTagFilter.toLowerCase())
    }
    return true
  })

  // Combine verified listings with legacy profiles
  // Verified listings come first (supporters)
  const allProfiles = [
    ...verifiedListings.map(listing => ({
      ...listing,
      isVerifiedListing: true
    })),
    ...filteredProfiles.map(profile => ({
      ...profile,
      isVerifiedListing: false
    }))
  ]

  // Show filter indicator if filtering
  const filterIndicator = activeTagFilter
    ? `<div class="supporter-filter-indicator">
        Filtering by: <span class="tag-pill">#${escapeHtml(activeTagFilter)}</span>
        <button class="clear-filter-btn" id="clearTagFilter">Clear</button>
      </div>`
    : ''

  if (allProfiles.length === 0) {
    container.innerHTML = `
      ${filterIndicator}
      <div class="discovery-empty">
        <p>${activeTagFilter ? 'No profiles match this tag' : 'No supporters yet'}</p>
        <p class="hint">${activeTagFilter ? 'Try a different tag or clear the filter' : 'Become a supporter for $12 USD to help fund development and get a Supporter badge'}</p>
      </div>
    `
    setupClearFilterHandler()
    return
  }

  // Get list of already-followed swarm IDs
  const following = new Set(state.feed?.getFollowing() || [])

  container.innerHTML = filterIndicator + allProfiles.map(item => {
    const isVerified = item.isVerifiedListing

    // Handle both verified listings (from SupporterManager) and legacy profiles
    let name, avatar, tagline, tags, pubkey, swarmId, vouchedBy

    if (isVerified) {
      // Verified listing structure from SupporterManager
      name = item.profile?.name || item.pubkey?.slice(0, 12) + '...'
      avatar = item.profile?.avatar
      tagline = item.listing?.tagline || ''
      tags = item.listing?.tags || []
      pubkey = item.pubkey
      swarmId = item.swarmId
      vouchedBy = item.vouchedBy || []
    } else {
      // Legacy profile structure
      name = item.profile?.name || item.swarmId?.slice(0, 12) + '...'
      avatar = item.profile?.avatar
      tagline = item.discoveryProfile?.tagline || ''
      tags = item.discoveryProfile?.tags || []
      pubkey = item.pubkey
      swarmId = item.swarmId
      vouchedBy = item.vouchedBy || []
    }

    const initial = name.charAt(0).toUpperCase()
    const isFollowing = swarmId && following.has(swarmId)

    // Check vouch status
    const isVouched = state.discovery?.isVouched?.(pubkey) || false

    // Get social proof - only show vouchers that are in peerProfiles (people you follow)
    const knownVouchers = vouchedBy.filter(voucherPubkey =>
      state.peerProfiles && state.peerProfiles[voucherPubkey]
    )
    const socialProofHtml = knownVouchers.length > 0
      ? `<div class="social-proof">Vouched by ${knownVouchers.map(pk => {
          const voucherProfile = state.peerProfiles[pk]
          const voucherName = voucherProfile?.name || pk.slice(0, 8) + '...'
          return `@${escapeHtml(voucherName)}`
        }).join(', ')}</div>`
      : ''

    const safeAv = safeAvatarUrl(avatar)
    const avatarHtml = safeAv
      ? `<div class="discovery-avatar"><img src="${escapeHtml(safeAv)}" alt=""></div>`
      : `<div class="discovery-avatar">${escapeHtml(initial)}</div>`

    const tagsHtml = tags.length > 0
      ? `<div class="discovery-tags">${tags.slice(0, 5).map(tag =>
          `<span class="tag-pill clickable" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`
        ).join('')}</div>`
      : ''

    // Supporter badge for verified paid listings
    const supporterBadge = isVerified
      ? '<span class="supporter-badge" title="Paid listing - supports Swarmnero development"><span class="badge-icon">★</span>Supporter</span>'
      : ''

    const safePk = escapeHtml(pubkey || '')
    const safeSid = escapeHtml(swarmId || '')
    return `
      <div class="discovery-item supporter-item ${isVerified ? 'verified-listing' : ''}" data-pubkey="${safePk}" data-swarm-id="${safeSid}">
        ${avatarHtml}
        <div class="discovery-info">
          <span class="discovery-name">${escapeHtml(name)} ${supporterBadge}</span>
          ${tagline ? `<span class="discovery-tagline">${escapeHtml(tagline.slice(0, 100))}${tagline.length > 100 ? '...' : ''}</span>` : ''}
          ${tagsHtml}
          ${socialProofHtml}
        </div>
        <div class="discovery-actions">
          <button class="vouch-btn ${isVouched ? 'vouched' : ''}" data-pubkey="${safePk}" title="${isVouched ? 'Remove vouch' : 'Vouch for this person'}">
            ${isVouched ? '&#9733;' : '&#9734;'}
          </button>
          ${swarmId && !isFollowing
            ? `<button class="discovery-follow-btn" data-swarm-id="${safeSid}">Follow</button>`
            : (isFollowing ? '<span class="discovery-following">Following</span>' : '')
          }
        </div>
      </div>
    `
  }).join('')

  // Setup event handlers
  setupClearFilterHandler()
  setupTagClickHandlers(container)
  setupVouchHandlers(container)
  setupSupporterFollowHandlers(container)
  setupSupporterProfileClickHandlers(container)
}

/**
 * Setup clear filter button handler
 */
function setupClearFilterHandler() {
  const clearBtn = document.getElementById('clearTagFilter')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeTagFilter = null
      renderDiscovery()
    })
  }
}

/**
 * Setup tag click handlers for filtering
 */
function setupTagClickHandlers(container) {
  container.querySelectorAll('.tag-pill.clickable').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      const tag = pill.dataset.tag
      activeTagFilter = tag
      renderDiscovery()
    })
  })
}

/**
 * Setup vouch button handlers
 */
function setupVouchHandlers(container) {
  container.querySelectorAll('.vouch-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const isVouched = state.discovery?.isVouched?.(pubkey) || false

      try {
        if (isVouched) {
          await state.discovery?.unvouchProfile?.(pubkey)
        } else {
          await state.discovery?.vouchProfile?.(pubkey)
        }
        renderDiscovery()
      } catch (err) {
        console.error('Error vouching:', err)
      }
    })
  })
}

/**
 * Setup follow button handlers in supporter list
 */
function setupSupporterFollowHandlers(container) {
  container.querySelectorAll('.discovery-follow-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const swarmId = btn.dataset.swarmId
      if (!swarmId) return

      btn.disabled = true
      btn.textContent = '...'

      try {
        await state.feed.append(createFollowEvent({ swarmId }))
        await state.feed.follow(swarmId)
        if (refreshUICallback) await refreshUICallback()
        renderDiscovery()
      } catch (err) {
        alert('Error following: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Follow'
      }
    })
  })
}

/**
 * Setup click handlers to open profile when clicking on supporter item
 */
function setupSupporterProfileClickHandlers(container) {
  container.querySelectorAll('.supporter-item').forEach(item => {
    const openProfile = () => {
      const pubkey = item.dataset.pubkey
      const swarmId = item.dataset.swarmId
      if (!pubkey) return

      // Get profile data from supporter listing
      const listingManager = getSupporterManager()
      const listing = listingManager.getListing(pubkey)
      if (listing && listing.profile) {
        if (!state.peerProfiles) state.peerProfiles = {}
        if (!state.peerProfiles[pubkey]) {
          state.peerProfiles[pubkey] = {
            name: listing.profile.name,
            avatar: listing.profile.avatar,
            bio: listing.profile.bio
          }
        }
        if (swarmId && state.swarmIdToPubkey) {
          state.swarmIdToPubkey[swarmId] = pubkey
        }
      }

      // Check if this supporter is also online in Discovery — use enriched data
      const discoveryPeer = swarmId && state.discovery?.peers?.get(swarmId)
      if (discoveryPeer) {
        const profile = listing?.profile || discoveryPeer.profile || {}
        showProfileInCenter({
          name: profile.name || null,
          bio: profile.bio || null,
          avatar: profile.avatar || null,
          website: profile.website || null,
          swarmId,
          pubkey,
          postCount: discoveryPeer.postCount || 0,
          following: discoveryPeer.following || [],
          followers: discoveryPeer.followers || []
        })
      } else {
        // Supporter is offline — show basic profile
        const profile = listing?.profile || state.peerProfiles?.[pubkey] || {}
        showProfileInCenter({
          name: profile.name || null,
          bio: profile.bio || null,
          avatar: profile.avatar || null,
          website: profile.website || null,
          swarmId,
          pubkey
        })
      }
    }

    // Click on the info area (name, tagline) to open profile
    const infoArea = item.querySelector('.discovery-info')
    if (infoArea) {
      infoArea.style.cursor = 'pointer'
      infoArea.addEventListener('click', (e) => {
        // Don't trigger if clicking on tags
        if (e.target.closest('.tag-pill')) return
        openProfile()
      })
    }

    // Also make avatar clickable
    const avatar = item.querySelector('.discovery-avatar')
    if (avatar) {
      avatar.style.cursor = 'pointer'
      avatar.addEventListener('click', openProfile)
    }
  })
}

/**
 * Render popular tags section
 */
function renderPopularTags(cachedProfiles) {
  const container = document.getElementById('supporterPopularTags')
  if (!container || activeTab !== 'supporters') return

  // Calculate tag frequencies
  const tagCounts = new Map()
  for (const profile of cachedProfiles) {
    const tags = profile.discoveryProfile?.tags || []
    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
    }
  }

  // Get top 10 tags
  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag)

  if (topTags.length === 0) {
    container.innerHTML = ''
    return
  }

  container.innerHTML = `
    <div class="popular-tags">
      <h4>Popular Tags</h4>
      <div class="popular-tags-list">
        ${topTags.map(tag =>
          `<span class="tag-pill clickable ${activeTagFilter === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`
        ).join('')}
      </div>
    </div>
  `

  // Add click handlers
  container.querySelectorAll('.tag-pill.clickable').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag
      if (activeTagFilter === tag) {
        activeTagFilter = null
      } else {
        activeTagFilter = tag
      }
      renderDiscovery()
    })
  })
}

/**
 * Render the become-a-supporter form with payment flow
 */
function renderSupportForm() {
  const formContainer = document.getElementById('supportForm')
  if (!formContainer) return

  // Toggle visibility using the hidden class (matches CSS rule .post-to-supporter-form.hidden)
  if (showSupportForm) {
    formContainer.classList.remove('hidden')
  } else {
    formContainer.classList.add('hidden')
    return
  }

  // Check for pending payment that needs recovery - jump straight to payment step
  if (paymentStep === 'form') {
    try {
      const pendingPayment = localStorage.getItem('swarmnero_pending_supporter_payment')
      if (pendingPayment) {
        const { txHash, txKey } = JSON.parse(pendingPayment)
        if (txHash && txKey) {
          paymentStep = 'payment'
        }
      }
    } catch (e) {}
  }

  // Render based on current payment step
  switch (paymentStep) {
    case 'form':
      renderFormStep(formContainer)
      break
    case 'payment':
      renderPaymentStep(formContainer)
      break
    case 'verify':
      renderVerifyStep(formContainer)
      break
    case 'success':
      renderSuccessStep(formContainer)
      break
    default:
      renderFormStep(formContainer)
  }
}

/**
 * Render the initial form step (tagline and tags)
 */
function renderFormStep(formContainer) {
  // Calculate fee display
  const feeDisplay = listingFeeXMR
    ? `$${LISTING_FEE_USD.toFixed(2)} USD (~${listingFeeXMR.xmr.toFixed(4)} XMR)`
    : `$${LISTING_FEE_USD.toFixed(2)} USD`

  formContainer.innerHTML = `
    <div class="supporter-form">
      <h4>Support Swarmnero</h4>
      <p class="listing-fee-notice">Contribution: <strong>${feeDisplay}</strong> (paid in XMR)</p>
      <p class="listing-benefits hint">Help fund ongoing development, get a Supporter badge on your posts, and appear in the supporter directory.</p>
      <div class="form-group">
        <label>Tagline (optional)</label>
        <input type="text" id="supporterTagline" maxlength="100" placeholder="A brief description of yourself...">
      </div>
      <div class="form-group">
        <label>Select Tags (max 5)</label>
        <div class="suggested-tags" id="suggestedTagsContainer">
          ${suggestedTags.map(tag =>
            `<span class="tag-pill selectable ${selectedTags.includes(tag) ? 'selected' : ''}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`
          ).join('')}
        </div>
        <div class="custom-tag-input">
          <input type="text" id="customTagInput" placeholder="Add custom tag..." maxlength="50">
          <button type="button" id="addCustomTag">Add</button>
        </div>
        <div class="selected-tags" id="selectedTagsDisplay">
          ${selectedTags.map(tag =>
            `<span class="tag-pill selected" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <span class="remove-tag">x</span></span>`
          ).join('')}
        </div>
      </div>
      <div class="form-actions">
        <button type="button" id="cancelSupportForm" class="btn-secondary">Cancel</button>
        <button type="button" id="proceedToPayment" class="btn-primary" ${selectedTags.length === 0 ? 'disabled' : ''}>Become a Supporter</button>
      </div>
      <div id="supportFormFeedback" class="feedback-message"></div>
    </div>
  `

  setupFormStepHandlers(formContainer)
}

/**
 * Render the payment step
 */
async function renderPaymentStep(formContainer) {
  const isWalletUnlocked = wallet.isWalletUnlocked()

  // Check for pending payment that needs to be completed
  try {
    const pendingPayment = localStorage.getItem('swarmnero_pending_supporter_payment')
    if (pendingPayment) {
      const { txHash, txKey, amount, tags } = JSON.parse(pendingPayment)
      if (txHash && txKey) {
        // Restore payment proof and tags
        paymentTxHash = txHash
        paymentTxKey = txKey
        if (tags && tags.length) selectedTags = tags

        formContainer.innerHTML = `
          <div class="supporter-form">
            <h4>Complete Your Support</h4>
            <div class="payment-summary">
              <p class="hint">A previous payment was detected but the listing wasn't completed.</p>
              <p>TX ID: <code>${escapeHtml(txHash.slice(0, 20))}...</code></p>
            </div>
            <div class="form-actions">
              <button type="button" id="cancelPendingPayment" class="btn-secondary">Cancel</button>
              <button type="button" id="completePendingListing" class="btn-primary">Complete Listing</button>
            </div>
            <div id="supportFormFeedback" class="feedback-message"></div>
          </div>
        `

        // Setup handlers for pending payment recovery
        document.getElementById('cancelPendingPayment')?.addEventListener('click', () => {
          localStorage.removeItem('swarmnero_pending_supporter_payment')
          paymentTxHash = null
          paymentTxKey = null
          paymentStep = 'form'
          renderSupportForm()
        })

        document.getElementById('completePendingListing')?.addEventListener('click', async () => {
          const btn = document.getElementById('completePendingListing')
          const feedbackEl = document.getElementById('supportFormFeedback')
          if (btn) {
            btn.disabled = true
            btn.textContent = 'Completing...'
          }
          try {
            await addListingAfterPayment(txHash, txKey, BigInt(amount))
            localStorage.removeItem('swarmnero_pending_supporter_payment')
            paymentStep = 'success'
            renderSupportForm()
          } catch (err) {
            if (feedbackEl) {
              feedbackEl.textContent = 'Failed: ' + err.message
              feedbackEl.className = 'feedback-message error'
            }
            if (btn) {
              btn.disabled = false
              btn.textContent = 'Complete Listing'
            }
          }
        })

        return
      }
    }
  } catch (e) {
    console.warn('[Discovery] Error checking pending payment:', e)
  }

  // Fetch current XMR price if not cached
  if (!listingFeeXMR) {
    try {
      const manager = getSupporterManager()
      listingFeeXMR = await manager.getListingFeeXMR()
    } catch (e) {
      console.warn('[Discovery] Error getting listing fee:', e.message)
    }
  }

  const feeDisplay = listingFeeXMR
    ? `$${LISTING_FEE_USD.toFixed(2)} USD (~${listingFeeXMR.xmr.toFixed(4)} XMR)`
    : `$${LISTING_FEE_USD.toFixed(2)} USD`

  const xmrAmount = listingFeeXMR ? listingFeeXMR.xmr.toFixed(8) : '0.00000000'

  formContainer.innerHTML = `
    <div class="supporter-form">
      <h4>Pay Support Fee</h4>
      <div class="payment-summary">
        <p>Amount: <strong>${feeDisplay}</strong></p>
        <p>Send exactly <strong>${xmrAmount} XMR</strong> to:</p>
      </div>
      <div class="payment-address">
        <code class="address-display">${SWARMNERO_WALLET_ADDRESS}</code>
        <button type="button" id="copyAddress" class="btn-small" title="Copy address">Copy</button>
      </div>
      <div class="supporter-qr-container" id="supporterQrCode"></div>
      <div class="form-actions">
        <button type="button" id="backToForm" class="btn-secondary">Back</button>
        ${isWalletUnlocked
          ? '<button type="button" id="payAndList" class="btn-primary">Pay from Wallet</button>'
          : ''
        }
        <button type="button" id="enterPaymentProof" class="btn-secondary">I've Sent Payment</button>
      </div>
      <div id="supportFormFeedback" class="feedback-message"></div>
    </div>
  `

  // Generate QR code
  const qrContainer = document.getElementById('supporterQrCode')
  if (qrContainer && typeof QRCode !== 'undefined') {
    try {
      new QRCode(qrContainer, {
        text: `monero:${SWARMNERO_WALLET_ADDRESS}?tx_amount=${xmrAmount}`,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.M
      })
    } catch (err) {
      console.warn('[Discovery] QR code error:', err.message)
    }
  }

  setupPaymentStepHandlers(formContainer, isWalletUnlocked)
}

/**
 * Render the verification step
 */
function renderVerifyStep(formContainer) {
  const statusHtml = paymentStatus === 'pending'
    ? '<p class="status-pending">Verifying payment...</p>'
    : paymentStatus === 'failed'
    ? `<p class="status-failed">Verification failed: ${escapeHtml(paymentError || 'Unknown error')}</p>`
    : ''

  formContainer.innerHTML = `
    <div class="supporter-form">
      <h4>Enter Payment Proof</h4>
      <p class="hint">Enter your transaction details to verify payment</p>
      <div class="form-group">
        <label>Transaction ID (txHash)</label>
        <input type="text" id="paymentTxHash" placeholder="64-character transaction hash" value="${escapeHtml(paymentTxHash)}" ${paymentStatus === 'pending' ? 'disabled' : ''}>
      </div>
      <div class="form-group">
        <label>Transaction Key (txKey)</label>
        <input type="text" id="paymentTxKey" placeholder="Transaction private key for verification" value="${escapeHtml(paymentTxKey)}" ${paymentStatus === 'pending' ? 'disabled' : ''}>
        <p class="hint">Or enter combined format: txHash:txKey</p>
      </div>
      ${statusHtml}
      <div class="form-actions">
        <button type="button" id="backToPayment" class="btn-secondary" ${paymentStatus === 'pending' ? 'disabled' : ''}>Back</button>
        <button type="button" id="verifyAndList" class="btn-primary" ${paymentStatus === 'pending' ? 'disabled' : ''}>
          ${paymentStatus === 'pending' ? 'Verifying...' : 'Verify & List'}
        </button>
      </div>
      <div id="supportFormFeedback" class="feedback-message"></div>
    </div>
  `

  setupVerifyStepHandlers(formContainer)
}

/**
 * Render the success step
 */
function renderSuccessStep(formContainer) {
  const syncStatus = localStorage.getItem('swarmnero_sync_active') === 'true'

  formContainer.innerHTML = `
    <div class="supporter-form">
      <h4>Thank You for Your Support!</h4>
      <div class="success-message">
        <p>You are now a Swarmnero supporter!</p>
        <p class="hint">Your Supporter badge is now visible on your posts. Your contribution helps fund ongoing development of Swarmnero. Thank you!</p>
      </div>
      ${!syncStatus ? `
        <div class="sync-service-option">
          <h5>Feed Backup Service</h5>
          <p class="hint">Keep your posts available 24/7 even when you're offline. Your feed will be replicated on a dedicated server (up to 100MB). Included with your supporter subscription.</p>
          <button type="button" id="enableSyncService" class="btn-secondary">Enable Feed Backup</button>
          <div id="syncSetupStatus" class="sync-setup-status"></div>
        </div>
      ` : `
        <div class="sync-service-option">
          <p class="sync-active-label">Feed Backup: Active</p>
        </div>
      `}
      <div class="form-actions">
        <button type="button" id="closeSupportForm" class="btn-primary">Done</button>
      </div>
    </div>
  `

  // Enable sync service handler
  const enableSyncBtn = formContainer.querySelector('#enableSyncService')
  if (enableSyncBtn) {
    enableSyncBtn.addEventListener('click', async () => {
      const statusEl = formContainer.querySelector('#syncSetupStatus')
      enableSyncBtn.disabled = true
      enableSyncBtn.textContent = 'Starting…'

      try {
        const result = await runFeedBackupPurchase({
          onStatus: (msg) => { if (statusEl) statusEl.textContent = msg }
        })

        if (result.ok) {
          enableSyncBtn.textContent = 'Enabled!'
          enableSyncBtn.className = 'sync-active-label'
          if (statusEl) statusEl.textContent = 'Feed backup is now active. Your posts will be available 24/7.'
          return
        }
      } catch (err) {
        console.error('[Sync] Enable error:', err.message)
        if (statusEl) statusEl.textContent = err.message
        enableSyncBtn.disabled = false
        enableSyncBtn.textContent = 'Enable Feed Backup'
      }
    })
  }

  const closeBtn = formContainer.querySelector('#closeSupportForm')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      resetPaymentFlow()
      showSupportForm = false
      renderSupportForm()
      renderDiscovery()
    })
  }
}

/**
 * Reset payment flow state
 */
function resetPaymentFlow() {
  paymentStep = 'form'
  paymentTxHash = ''
  paymentTxKey = ''
  paymentStatus = null
  paymentError = null
  selectedTags = []
}

/**
 * Setup handlers for the form step (tags and tagline)
 */
function setupFormStepHandlers(container) {
  // Tag selection handlers
  container.querySelectorAll('.suggested-tags .tag-pill.selectable').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag
      toggleTagSelection(tag)
      renderSupportForm()
    })
  })

  // Remove tag handlers
  container.querySelectorAll('.selected-tags .remove-tag').forEach(removeBtn => {
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const pill = removeBtn.closest('.tag-pill')
      const tag = pill.dataset.tag
      selectedTags = selectedTags.filter(t => t !== tag)
      renderSupportForm()
    })
  })

  // Add custom tag
  const addCustomBtn = document.getElementById('addCustomTag')
  const customInput = document.getElementById('customTagInput')
  if (addCustomBtn && customInput) {
    addCustomBtn.addEventListener('click', () => {
      const tag = customInput.value.toLowerCase().replace(/^#/, '').trim()
      if (tag && !selectedTags.includes(tag) && selectedTags.length < 5) {
        selectedTags.push(tag)
        if (!suggestedTags.includes(tag)) {
          suggestedTags.push(tag)
        }
        customInput.value = ''
        renderSupportForm()
      }
    })

    customInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addCustomBtn.click()
      }
    })
  }

  // Cancel button
  const cancelBtn = document.getElementById('cancelSupportForm')
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      resetPaymentFlow()
      showSupportForm = false
      renderSupportForm()
    })
  }

  // Continue to payment button
  const proceedBtn = document.getElementById('proceedToPayment')
  if (proceedBtn) {
    proceedBtn.addEventListener('click', async () => {
      if (selectedTags.length === 0) return

      // Fetch listing fee before showing payment step
      try {
        const manager = getSupporterManager()
        listingFeeXMR = await manager.getListingFeeXMR()
      } catch (e) {
        console.warn('[Discovery] Error getting listing fee:', e.message)
      }

      paymentStep = 'payment'
      renderSupportForm()
    })
  }
}

/**
 * Setup handlers for the payment step
 */
function setupPaymentStepHandlers(container, isWalletUnlocked) {
  // Back button
  const backBtn = document.getElementById('backToForm')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      paymentStep = 'form'
      renderSupportForm()
    })
  }

  // Copy address button
  const copyBtn = document.getElementById('copyAddress')
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(SWARMNERO_WALLET_ADDRESS)
        copyBtn.textContent = 'Copied!'
        setTimeout(() => {
          copyBtn.textContent = 'Copy'
        }, 2000)
      } catch (e) {
        console.warn('[Discovery] Copy failed:', e.message)
      }
    })
  }

  if (isWalletUnlocked) {
    // Pay & List button (in-app payment)
    const payBtn = document.getElementById('payAndList')
    if (payBtn) {
      payBtn.addEventListener('click', async () => {
        await processInAppPayment()
      })
    }

    // Show manual payment option
    const manualLink = document.getElementById('showManualPayment')
    if (manualLink) {
      manualLink.addEventListener('click', (e) => {
        e.preventDefault()
        paymentStep = 'verify'
        renderSupportForm()
      })
    }
  } else {
    // I've Sent Payment button
    const enterProofBtn = document.getElementById('enterPaymentProof')
    if (enterProofBtn) {
      enterProofBtn.addEventListener('click', () => {
        paymentStep = 'verify'
        renderSupportForm()
      })
    }
  }
}

/**
 * Setup handlers for the verification step
 */
function setupVerifyStepHandlers(container) {
  // Back button
  const backBtn = document.getElementById('backToPayment')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      paymentStep = 'payment'
      paymentStatus = null
      paymentError = null
      renderSupportForm()
    })
  }

  // Verify & List button
  const verifyBtn = document.getElementById('verifyAndList')
  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      await verifyPaymentAndList()
    })
  }

  // Handle combined txHash:txKey format
  const txHashInput = document.getElementById('paymentTxHash')
  if (txHashInput) {
    txHashInput.addEventListener('input', (e) => {
      const value = e.target.value.trim()
      // Check if it's in combined format (txHash:txKey)
      if (value.includes(':')) {
        const [hash, key] = value.split(':')
        if (hash && key) {
          paymentTxHash = hash.trim()
          paymentTxKey = key.trim()
          // Update both fields
          e.target.value = paymentTxHash
          const txKeyInput = document.getElementById('paymentTxKey')
          if (txKeyInput) {
            txKeyInput.value = paymentTxKey
          }
        }
      } else {
        paymentTxHash = value
      }
    })
  }

  const txKeyInput = document.getElementById('paymentTxKey')
  if (txKeyInput) {
    txKeyInput.addEventListener('input', (e) => {
      paymentTxKey = e.target.value.trim()
    })
  }
}

/**
 * Process in-app payment when wallet is unlocked
 */
async function processInAppPayment() {
  const feedbackEl = document.getElementById('supportFormFeedback')
  const payBtn = document.getElementById('payAndList')

  // Check for public key BEFORE sending any payment
  if (!state.feed?.identity?.pubkeyHex) {
    if (feedbackEl) {
      feedbackEl.textContent = 'Error: No public key available. Please ensure you are logged in.'
      feedbackEl.className = 'feedback-message error'
    }
    return
  }

  if (!listingFeeXMR) {
    if (feedbackEl) {
      feedbackEl.textContent = 'Error: Could not determine listing fee'
      feedbackEl.className = 'feedback-message error'
    }
    return
  }

  if (payBtn) {
    payBtn.disabled = true
    payBtn.textContent = 'Processing...'
  }

  try {
    // Create transaction
    const amount = listingFeeXMR.atomicUnits
    const { fee, tx } = await wallet.createTransaction(SWARMNERO_WALLET_ADDRESS, amount)

    // Confirm with user (simple confirm for now)
    const feeXMR = wallet.formatXMR(fee)
    const amountXMR = wallet.formatXMR(amount)
    const confirmed = confirm(`Send ${amountXMR} XMR + ${feeXMR} XMR fee to become a Swarmnero supporter?`)

    if (!confirmed) {
      wallet.cancelPendingTransaction()
      if (payBtn) {
        payBtn.disabled = false
        payBtn.textContent = 'Pay & List'
      }
      return
    }

    // Relay the transaction
    const { txHash, txKey } = await wallet.relayTransaction()

    // Store the payment proof IMMEDIATELY after successful payment
    // This ensures we can retry if listing fails
    paymentTxHash = txHash
    paymentTxKey = txKey

    // Persist payment proof to localStorage for recovery
    try {
      localStorage.setItem('swarmnero_pending_supporter_payment', JSON.stringify({
        txHash, txKey, amount: amount.toString(), tags: selectedTags, timestamp: Date.now()
      }))
    } catch (e) {
      console.warn('[Discovery] Could not persist payment proof:', e)
    }

    // Refresh wallet to update balance
    await wallet.refreshAfterSend()

    // Add the listing
    await addListingAfterPayment(txHash, txKey, amount)

    // Clear persisted payment on success
    try {
      localStorage.removeItem('swarmnero_pending_supporter_payment')
    } catch (e) {}

    // Show success
    paymentStep = 'success'
    renderSupportForm()

  } catch (err) {
    console.error('[Discovery] In-app payment error:', err)

    // Check if payment succeeded but listing failed
    if (paymentTxHash && paymentTxKey) {
      if (feedbackEl) {
        feedbackEl.innerHTML = `
          <span class="error">Listing failed: ${escapeHtml(err.message || '')}</span>
          <br><br>
          <strong>Your payment was sent.</strong> TX ID: <code>${escapeHtml(paymentTxHash.slice(0, 16))}...</code>
          <br>
          <button type="button" id="retryListing" class="btn-primary" style="margin-top: 8px;">Retry Listing</button>
        `
        feedbackEl.className = 'feedback-message'

        // Add retry handler
        const retryBtn = document.getElementById('retryListing')
        if (retryBtn) {
          retryBtn.addEventListener('click', async () => {
            retryBtn.disabled = true
            retryBtn.textContent = 'Retrying...'
            try {
              await addListingAfterPayment(paymentTxHash, paymentTxKey, amount)
              localStorage.removeItem('swarmnero_pending_supporter_payment')
              paymentStep = 'success'
              renderSupportForm()
            } catch (retryErr) {
              feedbackEl.textContent = 'Retry failed: ' + retryErr.message
              feedbackEl.className = 'feedback-message error'
              retryBtn.disabled = false
              retryBtn.textContent = 'Retry Listing'
            }
          })
        }
      }
      if (payBtn) {
        payBtn.style.display = 'none'
      }
    } else {
      if (feedbackEl) {
        feedbackEl.textContent = 'Payment failed: ' + err.message
        feedbackEl.className = 'feedback-message error'
      }
      if (payBtn) {
        payBtn.disabled = false
        payBtn.textContent = 'Pay & List'
      }
    }
  }
}

/**
 * Verify payment and add listing
 */
async function verifyPaymentAndList() {
  // Get current values from inputs
  const txHashInput = document.getElementById('paymentTxHash')
  const txKeyInput = document.getElementById('paymentTxKey')

  paymentTxHash = txHashInput?.value?.trim() || paymentTxHash
  paymentTxKey = txKeyInput?.value?.trim() || paymentTxKey

  if (!paymentTxHash) {
    paymentError = 'Transaction ID is required'
    paymentStatus = 'failed'
    renderSupportForm()
    return
  }

  if (!paymentTxKey) {
    paymentError = 'Transaction Key is required for verification'
    paymentStatus = 'failed'
    renderSupportForm()
    return
  }

  // Validate txHash format (64 hex characters)
  if (!/^[a-fA-F0-9]{64}$/.test(paymentTxHash)) {
    paymentError = 'Invalid transaction ID format (must be 64 hex characters)'
    paymentStatus = 'failed'
    renderSupportForm()
    return
  }

  // Validate txKey format (64 hex characters, same as txHash)
  if (!/^[a-fA-F0-9]{64}$/.test(paymentTxKey)) {
    paymentError = `Invalid TX key format (must be 64 hex characters, got ${paymentTxKey.length} chars)`
    paymentStatus = 'failed'
    renderSupportForm()
    return
  }

  paymentStatus = 'pending'
  renderSupportForm()

  try {
    // Verify the payment using wallet's checkTxKey
    const result = await wallet.checkTxKey(paymentTxHash, SWARMNERO_WALLET_ADDRESS, paymentTxKey)

    if (!result.verified) {
      paymentError = result.reason || 'Payment could not be verified'
      paymentStatus = 'failed'
      renderSupportForm()
      return
    }

    // Check if amount is sufficient
    const requiredAmount = listingFeeXMR?.atomicUnits || BigInt(0)
    if (result.amount < requiredAmount) {
      paymentError = `Insufficient payment. Required: ${wallet.formatXMR(requiredAmount)} XMR, received: ${wallet.formatXMR(result.amount)} XMR`
      paymentStatus = 'failed'
      renderSupportForm()
      return
    }

    // Add the listing
    await addListingAfterPayment(paymentTxHash, paymentTxKey, result.amount)

    // Show success
    paymentStatus = null
    paymentStep = 'success'
    renderSupportForm()

  } catch (err) {
    console.error('[Discovery] Payment verification error:', err)
    paymentError = err.message || 'Verification failed'
    paymentStatus = 'failed'
    renderSupportForm()
  }
}

/**
 * Add listing after successful payment. If a listing already exists, treat
 * this as a renewal: extend the existing listing's expiry via renewListing(),
 * preserve its tags/tagline unless the user edited them, and — if feed backup
 * was active — call enableBackup() with the new tx so the sync server extends
 * its expiry too.
 */
async function addListingAfterPayment(txHash, txKey, amount) {
  const taglineInput = document.getElementById('supporterTagline')
  const taglineValue = taglineInput?.value?.trim()

  const manager = getSupporterManager()

  const pubkey = state.feed?.identity?.pubkeyHex || null
  const swarmId = state.feed?.swarmId || null

  if (!pubkey) {
    throw new Error('No public key available')
  }

  const txProof = `${txHash}:${txKey}`
  const existing = manager.getListing(pubkey)
  const isRenewal = !!(existing && existing.paymentConfirmed)

  let effectiveTags = selectedTags
  let effectiveTagline = taglineValue || null
  if (isRenewal) {
    if (!effectiveTags || effectiveTags.length === 0) effectiveTags = existing.listing?.tags || []
    if (taglineValue === undefined || taglineValue === null) effectiveTagline = existing.listing?.tagline || null
  }

  if (isRenewal) {
    manager.renewListing(pubkey, txProof)
    const listing = manager.listings.get(pubkey)
    if (listing) {
      listing.listing.tags = effectiveTags
      listing.listing.tagline = effectiveTagline
      listing.listing.amount = amount.toString()
      manager.listings.set(pubkey, listing)
      manager.saveListings()
    }
  } else {
    manager.addListing(
      pubkey,
      state.myProfile || {},
      {
        tags: effectiveTags,
        tagline: effectiveTagline,
        tx_proof: txProof,
        amount: amount.toString(),
        seq: 1
      },
      swarmId
    )
  }

  // Publish supporter_listing event for P2P propagation (includes tx_proof)
  const existingProfile = state.discovery?.myDiscoveryProfile
  const seq = (existingProfile?.seq || 0) + 1

  const event = createSupporterListingEvent({
    tags: effectiveTags,
    tagline: effectiveTagline,
    txProof,
    amount: amount.toString(),
    seq,
    visible: true
  })

  await state.feed.append(event)

  if (state.discovery?.setMyDiscoveryProfile) {
    state.discovery.setMyDiscoveryProfile({
      tags: effectiveTags,
      tagline: effectiveTagline,
      seq,
      visible: true
    })
  }

  // If the user had feed backup active, extend the server-side expiry using
  // the new tx_proof. The server's sync_enable verifies the new payment and
  // stacks expiry onto the existing record.
  if (isRenewal && localStorage.getItem('swarmnero_sync_active') === 'true') {
    try {
      if (state.syncClient) {
        await state.syncClient.enableBackup(txHash, txKey)
      }
    } catch (err) {
      console.warn('[Discovery] Backup expiry extension failed:', err.message)
    }
  }
}

/**
 * Toggle tag selection
 */
function toggleTagSelection(tag) {
  if (selectedTags.includes(tag)) {
    selectedTags = selectedTags.filter(t => t !== tag)
  } else if (selectedTags.length < 5) {
    selectedTags.push(tag)
  }
}

/**
 * Initialize discovery component
 */
export function initDiscovery(refreshUI) {
  refreshUICallback = refreshUI

  // Set up tab handlers immediately (they're static HTML elements)
  setupTabHandlers()

  // Toggle handler
  const toggle = document.getElementById('discoveryToggle')
  if (toggle) {
    toggle.addEventListener('change', () => {
      if (!state.discovery) return

      if (toggle.checked) {
        // Enable discovery
        state.discovery.setProfile(state.myProfile, state.feed?.swarmId)
        state.discovery.enable()
      } else {
        // Disable discovery
        state.discovery.disable()
      }

      renderDiscovery()
    })
  }

  // Support Swarmnero button handler
  const supportSwarmneroBtn = document.getElementById('supportSwarmneroBtn')
  if (supportSwarmneroBtn) {
    supportSwarmneroBtn.addEventListener('click', async () => {
      showSupportForm = !showSupportForm
      if (showSupportForm) {
        // Reset payment flow state
        resetPaymentFlow()

        // Load suggested tags
        try {
          const events = await state.feed?.read?.() || []
          suggestedTags = suggestTags(state.myProfile, events)
        } catch (err) {
          console.error('Error loading suggested tags:', err)
          suggestedTags = []
        }

        // Pre-fetch listing fee for display
        try {
          const manager = getSupporterManager()
          listingFeeXMR = await manager.getListingFeeXMR()
        } catch (err) {
          console.warn('[Discovery] Error fetching listing fee:', err)
          listingFeeXMR = null
        }
      }
      renderSupportForm()
    })
  }

  // Set up discovery callbacks if discovery exists
  if (state.discovery) {
    setupDiscoveryCallbacks()
  }
}

/**
 * Set up callbacks for discovery events
 */
export function setupDiscoveryCallbacks() {
  if (!state.discovery) return

  // Seed the online set from any peers already known at setup time
  if (state.discovery.peers) {
    for (const swarmId of state.discovery.peers.keys()) {
      state.onlineSwarmIds.add(swarmId)
    }
  }

  state.discovery.onPeerDiscovered = (peer) => {
    console.log('[Discovery UI] Peer discovered:', peer.profile?.name || peer.swarmId.slice(0, 8))
    if (peer.swarmId) state.onlineSwarmIds.add(peer.swarmId)
    // Map swarmId <-> pubkey for discovered peers
    if (peer.swarmId && peer.pubkey) {
      if (!state.swarmIdToPubkey) state.swarmIdToPubkey = {}
      if (!state.pubkeyToSwarmId) state.pubkeyToSwarmId = {}
      state.swarmIdToPubkey[peer.swarmId] = peer.pubkey
      state.pubkeyToSwarmId[peer.pubkey] = peer.swarmId
    }
    // Detect unfollows: if peer's following list doesn't include us, remove from our followers
    if (peer.following && state.feed && peer.swarmId) {
      const mySwarmId = state.feed.swarmId
      const theyFollowUs = peer.following.some(f => f.swarmId === mySwarmId)
      if (theyFollowUs) {
        state.feed.followers.add(peer.swarmId)
        state.feed._saveFollowers?.()
      } else if (state.feed.followers.has(peer.swarmId)) {
        state.feed.followers.delete(peer.swarmId)
        state.feed._saveFollowers?.()
        console.log(`[Discovery UI] Removed stale follower: ${peer.swarmId.slice(0, 8)}`)
      }
    }
    if (refreshUICallback) refreshUICallback()
    renderDiscovery()
  }

  state.discovery.onPeerLeft = (swarmId) => {
    console.log('[Discovery UI] Peer left:', swarmId.slice(0, 8))
    if (swarmId) state.onlineSwarmIds.delete(swarmId)
    if (refreshUICallback) refreshUICallback()
    renderDiscovery()
  }

  state.discovery.onPeerCountChanged = (count) => {
    const countEl = document.getElementById('discoveryCount')
    if (countEl) {
      countEl.textContent = count
    }
  }

  // Add callback for cached profiles update
  if (state.discovery.onCachedProfilesUpdated) {
    state.discovery.onCachedProfilesUpdated = () => {
      renderDiscovery()
    }
  }
}

/**
 * Update discovery with current profile
 */
export function updateDiscoveryProfile() {
  if (state.discovery) {
    console.log('[App] updateDiscoveryProfile called', {
      hasProfile: !!state.myProfile,
      feedSwarmId: state.feed?.swarmId?.slice(0, 12)
    })
    state.discovery.setProfile(state.myProfile, state.feed?.swarmId)
  }
}
