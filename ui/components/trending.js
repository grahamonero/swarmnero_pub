/**
 * Trending component - displays trending hashtags from the network
 * Shows tag name + post count with time period filtering
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { getTagIndex } from '../../lib/tag-index.js'
import { resetToPanel } from './panel.js'
import { performSearch } from './search.js'

// Local state for trending component
let activePeriod = 'all'  // '24h', '7d', or 'all'
let trendingData = []     // Cached trending data

/**
 * Build a Set of "pubkey:timestamp" keys for deleted posts from the current timeline.
 * Mirrors the canonical filter used in lib/feed.js getPosts and ui/components/timeline.js renderPosts.
 * @returns {Set<string>}
 */
function buildDeletedKeys() {
  const timeline = state.currentTimeline || []
  return new Set(
    timeline
      .filter(e => e.type === 'delete' && e.pubkey)
      .map(e => `${e.pubkey}:${e.post_timestamp}`)
  )
}

/**
 * Render the trending panel
 */
export function renderTrending() {
  const container = dom.trendingContent || document.getElementById('trendingContent')
  if (!container) return

  // Get trending data from TagIndex, excluding posts that have been soft-deleted
  const tagIndex = getTagIndex()
  const deletedKeys = buildDeletedKeys()
  const allTrending = tagIndex.getTrending(20, deletedKeys) // Get more to filter by time

  // Filter by time period
  trendingData = filterByPeriod(allTrending, activePeriod, deletedKeys)

  container.innerHTML = `
    <div class="trending-container">
      <div class="trending-header">
        <h3>Trending in your network</h3>
        <div class="time-filter">
          <button class="time-filter-btn ${activePeriod === '24h' ? 'active' : ''}" data-period="24h">24h</button>
          <button class="time-filter-btn ${activePeriod === '7d' ? 'active' : ''}" data-period="7d">7d</button>
          <button class="time-filter-btn ${activePeriod === 'all' ? 'active' : ''}" data-period="all">All</button>
        </div>
      </div>
      <div class="trending-list">
        ${renderTrendingList(trendingData)}
      </div>
    </div>
  `

  // Setup handlers after rendering
  setupTrendingHandlers()
}

/**
 * Filter trending tags by time period
 * @param {Array} tags - Array of { tag, count } from TagIndex
 * @param {string} period - '24h', '7d', or 'all'
 * @param {Set<string>} [deletedKeys] - Optional set of "pubkey:timestamp" keys for deleted posts
 * @returns {Array} Filtered tags with post counts for the period
 */
function filterByPeriod(tags, period, deletedKeys = null) {
  if (period === 'all') {
    return tags.slice(0, 10)
  }

  const now = Date.now()
  let cutoffTime

  if (period === '24h') {
    cutoffTime = now - (24 * 60 * 60 * 1000)
  } else if (period === '7d') {
    cutoffTime = now - (7 * 24 * 60 * 60 * 1000)
  } else {
    return tags.slice(0, 10)
  }

  // Get TagIndex to filter by timestamp (deleted posts already excluded via deletedKeys)
  const tagIndex = getTagIndex()
  const filteredTags = []

  for (const { tag } of tags) {
    // Get posts for this tag and filter by time
    const posts = tagIndex.search(tag, deletedKeys)
    const recentPosts = posts.filter(p => p.timestamp >= cutoffTime)

    if (recentPosts.length > 0) {
      filteredTags.push({
        tag,
        count: recentPosts.length,
        // Calculate trend direction based on recent activity
        trend: calculateTrend(posts, cutoffTime)
      })
    }
  }

  // Sort by count descending
  filteredTags.sort((a, b) => b.count - a.count)

  return filteredTags.slice(0, 10)
}

/**
 * Calculate trend direction for a tag
 * @param {Array} posts - All posts for this tag
 * @param {number} cutoffTime - Start of the time period
 * @returns {string} 'up', 'down', or 'stable'
 */
function calculateTrend(posts, cutoffTime) {
  const periodLength = Date.now() - cutoffTime
  const previousPeriodStart = cutoffTime - periodLength

  // Count posts in current period vs previous period
  const currentCount = posts.filter(p => p.timestamp >= cutoffTime).length
  const previousCount = posts.filter(
    p => p.timestamp >= previousPeriodStart && p.timestamp < cutoffTime
  ).length

  if (currentCount > previousCount * 1.2) {
    return 'up'
  } else if (currentCount < previousCount * 0.8) {
    return 'down'
  }
  return 'stable'
}

/**
 * Render the trending list HTML
 * @param {Array} tags - Array of { tag, count, trend? }
 * @returns {string} HTML string
 */
function renderTrendingList(tags) {
  if (tags.length === 0) {
    return `
      <div class="trending-empty">
        <p>No trending tags found</p>
        <p class="hint">Tags from posts in your network will appear here</p>
      </div>
    `
  }

  return tags.map((item, index) => {
    const trendIcon = getTrendIcon(item.trend)
    const postLabel = item.count === 1 ? 'post' : 'posts'

    return `
      <div class="trending-item" data-tag="${escapeHtml(item.tag)}">
        <span class="trending-rank">${index + 1}</span>
        <div class="trending-info">
          <span class="tag-name">#${escapeHtml(item.tag)}</span>
          <span class="post-count">${item.count} ${postLabel}</span>
        </div>
        ${trendIcon ? `<span class="trend-indicator ${item.trend}">${trendIcon}</span>` : ''}
      </div>
    `
  }).join('')
}

/**
 * Get trend icon based on direction
 * @param {string} trend - 'up', 'down', or 'stable'
 * @returns {string} HTML for trend icon
 */
function getTrendIcon(trend) {
  if (!trend || trend === 'stable') {
    return ''
  }
  if (trend === 'up') {
    return '<span class="trend-up" title="Trending up">&#9650;</span>'
  }
  if (trend === 'down') {
    return '<span class="trend-down" title="Trending down">&#9660;</span>'
  }
  return ''
}

/**
 * Setup event handlers for trending component
 */
export function setupTrendingHandlers() {
  const container = dom.trendingContent || document.getElementById('trendingContent')
  if (!container) return

  // Time filter button handlers
  container.querySelectorAll('.time-filter-btn').forEach(btn => {
    if (btn.dataset.handlerAttached) return
    btn.dataset.handlerAttached = 'true'

    btn.addEventListener('click', () => {
      const period = btn.dataset.period
      if (period && period !== activePeriod) {
        activePeriod = period
        renderTrending()
      }
    })
  })

  // Tag click handlers - navigate to search
  container.querySelectorAll('.trending-item').forEach(item => {
    if (item.dataset.handlerAttached) return
    item.dataset.handlerAttached = 'true'

    item.addEventListener('click', async () => {
      const tag = item.dataset.tag
      if (tag) {
        await navigateToTagSearch(tag)
      }
    })
  })
}

/**
 * Navigate to search results for a tag
 * @param {string} tag - Tag to search for
 */
async function navigateToTagSearch(tag) {
  // Switch to Search view first
  await resetToPanel('search')

  // Now the searchInput element exists - set its value for display
  const searchInput = document.getElementById('searchInput')
  if (searchInput) {
    searchInput.value = `#${tag}`
  }

  // Perform the search (this will also update the input and render results)
  await performSearch(tag)
}

/**
 * Refresh trending data
 * Call this when new posts are indexed
 */
export function refreshTrending() {
  renderTrending()
}

/**
 * Get current trending data
 * @returns {Array} Current trending tags
 */
export function getTrendingData() {
  return trendingData
}

/**
 * Set active time period
 * @param {string} period - '24h', '7d', or 'all'
 */
export function setActivePeriod(period) {
  if (['24h', '7d', 'all'].includes(period)) {
    activePeriod = period
    renderTrending()
  }
}
