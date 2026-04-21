/**
 * Search component - hashtag search UI
 * Allows searching posts by hashtag with results grouped by source (own, following, fof)
 * FoF posts show "via @Username" badge with Follow button
 */

import { state, dom } from '../state.js'
import { escapeHtml, safeAvatarUrl } from '../utils/dom.js'
import { formatTime, getDisplayName, renderMarkdown } from '../utils/format.js'
import { getTagIndex } from '../../lib/tag-index.js'
import { createFollowEvent } from '../../lib/events.js'
import { pushPanel } from './panel.js'
import { showThreadInCenter } from './timeline.js'

// Local state for search component
let recentSearches = []          // Last 5 searches
let currentSearchResults = []    // Current search results
let currentSearchTag = ''        // Current search tag
let refreshUICallback = null     // Callback to refresh UI

// Maximum recent searches to store
const MAX_RECENT_SEARCHES = 5

/**
 * Get account-specific localStorage key for recent searches
 */
function getRecentSearchesKey() {
  const accountName = state.activeAccountName
  return accountName ? `swarmnero_recent_searches_${accountName}` : 'swarmnero_recent_searches'
}

/**
 * Load recent searches from localStorage
 */
function loadRecentSearches() {
  try {
    const stored = localStorage.getItem(getRecentSearchesKey())
    if (stored) {
      recentSearches = JSON.parse(stored).slice(0, MAX_RECENT_SEARCHES)
    } else {
      recentSearches = []
    }
  } catch (e) {
    console.warn('[Search] Error loading recent searches:', e.message)
    recentSearches = []
  }
}

/**
 * Save recent searches to localStorage
 */
function saveRecentSearches() {
  try {
    localStorage.setItem(getRecentSearchesKey(), JSON.stringify(recentSearches))
  } catch (e) {
    console.warn('[Search] Error saving recent searches:', e.message)
  }
}

/**
 * Add a tag to recent searches
 * @param {string} tag - The tag to add (without #)
 */
function addToRecentSearches(tag) {
  if (!tag) return

  // Remove if already exists
  recentSearches = recentSearches.filter(t => t !== tag)

  // Add to beginning
  recentSearches.unshift(tag)

  // Keep only the last MAX_RECENT_SEARCHES
  recentSearches = recentSearches.slice(0, MAX_RECENT_SEARCHES)

  saveRecentSearches()
}

/**
 * Render the search panel
 */
export function renderSearch() {
  const container = dom.searchContent || document.getElementById('searchContent')
  if (!container) return

  // Load recent searches if not already loaded
  if (recentSearches.length === 0) {
    loadRecentSearches()
  }

  container.innerHTML = `
    <div class="search-container">
      <div class="search-input-wrapper">
        <input type="text" id="searchInput" placeholder="Search #hashtags..." value="${escapeHtml(currentSearchTag)}" />
        <button id="searchBtn">Search</button>
      </div>
      <div class="recent-searches" id="recentSearches">
        ${renderRecentSearches()}
      </div>
      <div class="search-results" id="searchResults">
        ${renderSearchResults()}
      </div>
    </div>
  `

  // Setup handlers after rendering
  setupSearchHandlers()
}

/**
 * Render recent searches section
 * @returns {string} HTML string
 */
function renderRecentSearches() {
  if (recentSearches.length === 0) {
    return ''
  }

  return `
    <div class="recent-searches-header">
      <span>Recent Searches</span>
      <button id="clearRecentSearches" class="clear-btn">Clear</button>
    </div>
    <div class="recent-searches-list">
      ${recentSearches.map(tag =>
        `<span class="tag-pill clickable recent-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`
      ).join('')}
    </div>
  `
}

/**
 * Render search results grouped by source
 * @returns {string} HTML string
 */
function renderSearchResults() {
  if (!currentSearchTag) {
    return `
      <div class="search-empty">
        <p>Search for hashtags to find posts</p>
        <p class="hint">Enter a tag like #monero or #crypto</p>
      </div>
    `
  }

  if (currentSearchResults.length === 0) {
    return `
      <div class="search-empty">
        <p>No posts found for #${escapeHtml(currentSearchTag)}</p>
        <p class="hint">Try a different hashtag</p>
      </div>
    `
  }

  const myPubkey = state.identity?.pubkeyHex

  // Group results by source
  const ownPosts = currentSearchResults.filter(r => r.source === 'own')
  const followingPosts = currentSearchResults.filter(r => r.source === 'following')
  const fofPosts = currentSearchResults.filter(r => r.source === 'fof')

  let html = `<div class="search-results-header">Found ${currentSearchResults.length} post${currentSearchResults.length !== 1 ? 's' : ''} for #${escapeHtml(currentSearchTag)}</div>`

  // Render own posts section
  if (ownPosts.length > 0) {
    html += `
      <div class="search-section">
        <div class="search-section-header">Your Posts (${ownPosts.length})</div>
        ${ownPosts.map(post => renderSearchResultPost(post, myPubkey)).join('')}
      </div>
    `
  }

  // Render following posts section
  if (followingPosts.length > 0) {
    html += `
      <div class="search-section">
        <div class="search-section-header">From People You Follow (${followingPosts.length})</div>
        ${followingPosts.map(post => renderSearchResultPost(post, myPubkey)).join('')}
      </div>
    `
  }

  // Render FoF posts section
  if (fofPosts.length > 0) {
    html += `
      <div class="search-section">
        <div class="search-section-header">From Extended Network (${fofPosts.length})</div>
        ${fofPosts.map(post => renderSearchResultPost(post, myPubkey, true)).join('')}
      </div>
    `
  }

  return html
}

/**
 * Check if a post has replies (is part of a thread)
 * @param {string} pubkey - Post author's pubkey
 * @param {number} timestamp - Post timestamp
 * @returns {boolean} True if the post has replies
 */
function hasReplies(pubkey, timestamp) {
  if (!state.currentTimeline) return false

  return state.currentTimeline.some(
    p => p.type === 'reply' && p.to_pubkey === pubkey && p.post_timestamp === timestamp
  )
}

/**
 * Check if we have this post in our timeline (can view thread)
 * @param {string} pubkey - Post author's pubkey
 * @param {number} timestamp - Post timestamp
 * @returns {boolean} True if post exists in timeline
 */
function isInTimeline(pubkey, timestamp) {
  if (!state.currentTimeline) return false

  return state.currentTimeline.some(
    p => p.type === 'post' && p.pubkey === pubkey && p.timestamp === timestamp
  )
}

/**
 * Render a single search result post
 * @param {Object} post - The post object
 * @param {string} myPubkey - Current user's pubkey
 * @param {boolean} isFoF - Whether this is a FoF post
 * @returns {string} HTML string
 */
function renderSearchResultPost(post, myPubkey, isFoF = false) {
  // For FoF posts, use authorName if available, otherwise fall back to getDisplayName
  let displayName
  if (isFoF && post.authorName) {
    displayName = post.authorName
  } else {
    displayName = getDisplayName(post.pubkey, state.identity, state.myProfile, state.peerProfiles)
  }

  const profile = post.pubkey === myPubkey ? state.myProfile : state.peerProfiles[post.pubkey]
  const initial = displayName.charAt(0).toUpperCase()
  const safeAv = safeAvatarUrl(profile?.avatar)
  const avatarHtml = safeAv
    ? `<div class="search-result-avatar"><img src="${escapeHtml(safeAv)}" alt=""></div>`
    : `<div class="search-result-avatar">${escapeHtml(initial)}</div>`

  // Get via information for FoF posts
  let viaBadge = ''
  if (isFoF && post.viaSwarmId) {
    // Get the name of who sent us this post - use stored viaName if available
    let viaDisplayName = post.viaName
    if (!viaDisplayName) {
      const viaPubkey = state.swarmIdToPubkey?.[post.viaSwarmId]
      const viaProfile = viaPubkey ? state.peerProfiles[viaPubkey] : null
      viaDisplayName = viaProfile?.name || (viaPubkey
        ? getDisplayName(viaPubkey, state.identity, state.myProfile, state.peerProfiles)
        : post.viaSwarmId.slice(0, 8) + '...')
    }
    viaBadge = `<span class="via-badge">via @${escapeHtml(viaDisplayName)}</span>`
  }

  // Show full content (no truncation)
  const content = post.content || ''
  const noContent = !content

  // Check if this post is part of a thread
  const postHasReplies = hasReplies(post.pubkey, post.timestamp)
  const canViewThread = isInTimeline(post.pubkey, post.timestamp)
  const swarmId = post.authorSwarmId || post.swarmId || ''

  // Build thread action
  const safePk = escapeHtml(post.pubkey || '')
  const safeTs = escapeHtml(String(post.timestamp || ''))
  let threadAction = ''
  if (canViewThread && postHasReplies) {
    // Post is in our timeline and has replies - can view thread
    threadAction = `<button class="search-thread-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">View Thread</button>`
  } else if (isFoF && swarmId) {
    // FoF post - offer to retrieve conversation
    threadAction = `<button class="search-thread-btn search-retrieve-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}" data-swarm-id="${escapeHtml(swarmId)}">Retrieve Conversation</button>`
  } else if (canViewThread) {
    // Post is in timeline but no replies yet
    threadAction = `<button class="search-thread-btn" data-pubkey="${safePk}" data-timestamp="${safeTs}">View Post</button>`
  }

  return `
    <div class="search-result-item" data-pubkey="${safePk}" data-timestamp="${safeTs}">
      <div class="search-result-header">
        ${avatarHtml}
        <div class="search-result-meta">
          <span class="search-result-author">${escapeHtml(displayName)}</span>
          ${viaBadge}
          <span class="search-result-time">${formatTime(post.timestamp)}</span>
        </div>
      </div>
      <div class="search-result-content">${noContent ? '<em class="hint">Content not available</em>' : renderMarkdown(content)}</div>
      ${threadAction ? `<div class="search-result-actions">${threadAction}</div>` : ''}
    </div>
  `
}

/**
 * Setup event handlers for the search component
 */
export function setupSearchHandlers() {
  const container = dom.searchContent || document.getElementById('searchContent')
  if (!container) return

  // Search input and button
  const searchInput = document.getElementById('searchInput')
  const searchBtn = document.getElementById('searchBtn')

  if (searchInput && searchBtn) {
    // Handle enter key
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const tag = searchInput.value.trim().replace(/^#/, '')
        if (tag) {
          performSearch(tag)
        }
      }
    })

    // Handle search button click
    searchBtn.addEventListener('click', () => {
      const tag = searchInput.value.trim().replace(/^#/, '')
      if (tag) {
        performSearch(tag)
      }
    })
  }

  // Recent search tag clicks
  container.querySelectorAll('.recent-tag').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag
      if (tag) {
        performSearch(tag)
      }
    })
  })

  // Clear recent searches
  const clearBtn = document.getElementById('clearRecentSearches')
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      recentSearches = []
      saveRecentSearches()
      renderSearch()
    })
  }

  // Search result clicks - open profile view
  container.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      // Don't trigger if clicking on thread button, follow button, or links
      if (e.target.closest('.search-thread-btn') ||
          e.target.closest('.search-follow-btn') ||
          e.target.closest('a')) {
        return
      }

      const pubkey = item.dataset.pubkey
      if (pubkey) {
        pushPanel('profile', { pubkey, timeline: state.currentTimeline })
      }
    })

    // Make it visually clickable
    item.style.cursor = 'pointer'
  })

  // Thread button clicks - view thread or retrieve conversation
  container.querySelectorAll('.search-thread-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const pubkey = btn.dataset.pubkey
      const timestamp = parseInt(btn.dataset.timestamp, 10)
      const swarmId = btn.dataset.swarmId
      const isRetrieveBtn = btn.classList.contains('search-retrieve-btn')

      if (pubkey && timestamp) {
        // If this is specifically a "Retrieve Conversation" button, go directly to retrieve prompt
        if (isRetrieveBtn && swarmId) {
          showRetrievePrompt(swarmId, pubkey)
          return
        }

        // Try to show thread from timeline first
        const result = await showThreadInCenter(pubkey, timestamp)

        // If not found in timeline, check FoF cache and show simple view
        if (!result && state.fofCache) {
          const fofPost = state.fofCache.get(pubkey, timestamp)
          if (fofPost) {
            showFoFPostView(fofPost)
          } else if (swarmId) {
            // Offer to follow the user to retrieve their posts
            showRetrievePrompt(swarmId, pubkey)
          }
        }
      }
    })
  })
}

/**
 * Execute a hashtag search and display results
 * @param {string} tag - The tag to search for (without #)
 */
export async function performSearch(tag) {
  if (!tag || typeof tag !== 'string') {
    return
  }

  // Normalize tag
  const normalizedTag = tag.toLowerCase().replace(/^#/, '')
  currentSearchTag = normalizedTag

  // Add to recent searches
  addToRecentSearches(normalizedTag)

  // Get results from TagIndex, excluding soft-deleted posts.
  // Mirrors the canonical filter used in lib/feed.js getPosts and ui/components/timeline.js renderPosts.
  const tagIndex = getTagIndex()
  const timeline = state.currentTimeline || []
  const deletedKeys = new Set(
    timeline
      .filter(e => e.type === 'delete' && e.pubkey)
      .map(e => `${e.pubkey}:${e.post_timestamp}`)
  )
  const results = tagIndex.search(normalizedTag, deletedKeys)

  // Enhance results with full post data
  currentSearchResults = []

  for (const result of results) {
    // Try to get full post data from timeline or FoF cache
    let post = findPostInTimeline(result.pubkey, result.timestamp)

    if (!post && state.fofCache) {
      // Try FoF cache
      post = state.fofCache.get(result.pubkey, result.timestamp)
    }

    if (post) {
      currentSearchResults.push({
        ...post,
        source: result.source || determineSource(post)
      })
    } else {
      // Use content from tag index if available
      currentSearchResults.push({
        pubkey: result.pubkey,
        timestamp: result.timestamp,
        source: result.source || 'following',
        content: result.content || null // Content from tag index
      })
    }
  }

  // Sort by timestamp (newest first)
  currentSearchResults.sort((a, b) => b.timestamp - a.timestamp)

  // Re-render search component
  renderSearch()
}

/**
 * Find a post in the current timeline
 * @param {string} pubkey - Post author's pubkey
 * @param {number} timestamp - Post timestamp
 * @returns {Object|null} The post or null
 */
function findPostInTimeline(pubkey, timestamp) {
  if (!state.currentTimeline) return null

  return state.currentTimeline.find(
    p => p.type === 'post' && p.pubkey === pubkey && p.timestamp === timestamp
  )
}

/**
 * Determine the source of a post
 * @param {Object} post - The post object
 * @returns {string} 'own', 'following', or 'fof'
 */
function determineSource(post) {
  const myPubkey = state.identity?.pubkeyHex

  if (post.pubkey === myPubkey) {
    return 'own'
  }

  // Check if we follow this user
  const following = new Set(state.feed?.getFollowing() || [])
  const postSwarmId = post.swarmId

  if (postSwarmId && following.has(postSwarmId)) {
    return 'following'
  }

  // Check by pubkey in swarmIdToPubkey mapping
  if (state.swarmIdToPubkey) {
    for (const [swarmId, pubkey] of Object.entries(state.swarmIdToPubkey)) {
      if (pubkey === post.pubkey && following.has(swarmId)) {
        return 'following'
      }
    }
  }

  return 'fof'
}

/**
 * Initialize search component
 * @param {Function} refreshUI - Callback to refresh the UI
 */
export function initSearch(refreshUI) {
  refreshUICallback = refreshUI
  loadRecentSearches()
}

/**
 * Clear current search results
 */
export function clearSearch() {
  currentSearchTag = ''
  currentSearchResults = []
  recentSearches = []
  showingFoFView = false // Reset FoF view flag
  loadRecentSearches() // Reload per-account searches
  renderSearch()
}

// Flag to track if we're showing a FoF view in postsEl
let showingFoFView = false

/**
 * Clear FoF view and restore normal timeline display
 * Call this when navigating away from the FoF view
 */
export function clearFoFView() {
  if (showingFoFView && refreshUICallback) {
    showingFoFView = false
    refreshUICallback()
  }
}

/**
 * Check if FoF view is currently showing
 */
export function isFoFViewShowing() {
  return showingFoFView
}

/**
 * Show a FoF post in the center column (simplified view since we don't have full thread)
 * @param {Object} post - The FoF post object
 */
function showFoFPostView(post) {
  const displayName = post.authorName || `User ${post.pubkey.slice(0, 8)}...${post.pubkey.slice(-4)}`

  showingFoFView = true

  // Hide search section and show posts element
  const searchSection = document.getElementById('search-section')
  if (searchSection) searchSection.classList.add('hidden')
  dom.postsEl.classList.remove('hidden')

  // Show FoF post view
  dom.postsEl.innerHTML = `
    <div class="fof-post-view">
      <div class="fof-post-header">
        <button class="back-btn" id="fofBackBtn">&larr; Back to Search</button>
        <span class="fof-post-badge">From Extended Network</span>
      </div>
      <div class="fof-post-card">
        <div class="fof-post-author">
          <div class="fof-post-avatar">${displayName.charAt(0).toUpperCase()}</div>
          <div class="fof-post-meta">
            <span class="fof-post-name">${escapeHtml(displayName)}</span>
            <span class="fof-post-time">${formatTime(post.timestamp)}</span>
          </div>
        </div>
        <div class="fof-post-content">${renderMarkdown(post.content || '')}</div>
        ${post.tags && post.tags.length > 0 ? `
          <div class="fof-post-tags">
            ${post.tags.map(tag => `<span class="tag-pill">#${escapeHtml(tag)}</span>`).join(' ')}
          </div>
        ` : ''}
        ${post.authorSwarmId ? `
          <div class="fof-post-actions">
            <button class="fof-follow-btn" data-swarm-id="${escapeHtml(post.authorSwarmId)}">Follow ${escapeHtml(displayName)}</button>
          </div>
        ` : ''}
        <div class="fof-post-note">
          <em>Follow this user to see their full profile and all posts.</em>
        </div>
      </div>
    </div>
  `

  // Back button handler - navigate to search section
  document.getElementById('fofBackBtn')?.addEventListener('click', () => {
    showingFoFView = false
    if (refreshUICallback) refreshUICallback()
    // Show search section
    const searchSection = document.getElementById('search-section')
    const postsEl = document.getElementById('posts')
    if (searchSection && postsEl) {
      postsEl.classList.add('hidden')
      searchSection.classList.remove('hidden')
    }
    renderSearch()
  })

  // Follow button handler
  dom.postsEl.querySelector('.fof-follow-btn')?.addEventListener('click', async (e) => {
    const btn = e.target
    const swarmId = btn.dataset.swarmId
    if (!swarmId) return

    btn.disabled = true
    btn.textContent = 'Following...'

    try {
      await state.feed.append(createFollowEvent({ swarmId }))
      await state.feed.follow(swarmId)
      btn.textContent = 'Followed!'
      showingFoFView = false
      if (refreshUICallback) await refreshUICallback()
    } catch (err) {
      alert('Error following: ' + err.message)
      btn.disabled = false
      btn.textContent = 'Follow'
    }
  })
}

/**
 * Show a prompt to retrieve conversation by following the user
 * @param {string} swarmId - The user's swarm ID
 * @param {string} pubkey - The user's pubkey
 */
function showRetrievePrompt(swarmId, pubkey) {
  // Get display name if available
  const profile = state.peerProfiles[pubkey]
  const displayName = profile?.name || `User ${pubkey.slice(0, 8)}...`

  showingFoFView = true

  // Hide search section and show posts element
  const searchSection = document.getElementById('search-section')
  if (searchSection) searchSection.classList.add('hidden')
  dom.postsEl.classList.remove('hidden')

  // Show retrieve prompt view
  dom.postsEl.innerHTML = `
    <div class="fof-post-view">
      <div class="fof-post-header">
        <button class="back-btn" id="retrieveBackBtn">&larr; Back to Search</button>
        <span class="fof-post-badge">Retrieve Conversation</span>
      </div>
      <div class="fof-post-card">
        <div class="retrieve-prompt" id="retrievePromptContent">
          <p>To view the full conversation, you need to follow this user.</p>
          <p class="hint">Following will connect you to their feed and download their posts.</p>
        </div>
        <div class="fof-post-actions" id="retrieveActions">
          <button class="fof-follow-btn" id="retrieveFollowBtn" data-swarm-id="${escapeHtml(swarmId)}">
            Follow ${escapeHtml(displayName)} to Retrieve Posts
          </button>
        </div>
        <div class="fof-post-note">
          <em>Once connected, their posts will appear in your timeline and search results.</em>
        </div>
      </div>
    </div>
  `

  // Back button handler - navigate to search section
  document.getElementById('retrieveBackBtn')?.addEventListener('click', () => {
    showingFoFView = false
    if (refreshUICallback) refreshUICallback()
    // Show search section
    const searchSection = document.getElementById('search-section')
    const postsEl = document.getElementById('posts')
    if (searchSection && postsEl) {
      postsEl.classList.add('hidden')
      searchSection.classList.remove('hidden')
    }
    renderSearch()
  })

  // Follow button handler
  document.getElementById('retrieveFollowBtn')?.addEventListener('click', async (e) => {
    const btn = e.target
    const promptContent = document.getElementById('retrievePromptContent')
    const actionsDiv = document.getElementById('retrieveActions')

    // Immediately show loading state
    if (promptContent) {
      promptContent.innerHTML = `
        <div class="retrieve-loading">
          <div class="loading-spinner"></div>
          <p class="loading-status" id="loadingStatus">Connecting to user...</p>
        </div>
      `
    }
    if (actionsDiv) {
      actionsDiv.innerHTML = '<p class="hint">Please wait, this may take a moment...</p>'
    }

    const updateStatus = (text) => {
      const statusEl = document.getElementById('loadingStatus')
      if (statusEl) statusEl.textContent = text
    }

    try {
      updateStatus('Creating follow request...')
      await state.feed.append(createFollowEvent({ swarmId }))

      updateStatus('Connecting to peer network...')
      await state.feed.follow(swarmId)

      updateStatus('Syncing posts...')
      showingFoFView = false

      // Refresh UI to load their posts
      if (refreshUICallback) await refreshUICallback()

      updateStatus('Done! Redirecting to search...')

      // Navigate to search section after brief delay to show success
      setTimeout(() => {
        const searchSection = document.getElementById('search-section')
        const postsEl = document.getElementById('posts')
        if (searchSection && postsEl) {
          postsEl.classList.add('hidden')
          searchSection.classList.remove('hidden')
        }
        renderSearch()
      }, 500)
    } catch (err) {
      if (promptContent) {
        promptContent.innerHTML = `
          <p class="error-text">Error: ${escapeHtml(err.message)}</p>
          <p class="hint">Please try again or go back to search.</p>
        `
      }
      if (actionsDiv) {
        actionsDiv.innerHTML = `
          <button class="fof-follow-btn" id="fofRetryBtn">Retry</button>
        `
        const retryBtn = actionsDiv.querySelector('#fofRetryBtn')
        if (retryBtn) retryBtn.addEventListener('click', () => location.reload())
      }
    }
  })
}
