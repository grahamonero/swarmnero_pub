/**
 * Settings component - application settings panel UI
 * Includes FoF cache configuration and future settings
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'
import { runFeedBackupPurchase, runFeedBackupDisable } from './feed-backup.js'

// Default settings
const DEFAULT_SETTINGS = {
  fofCacheSize: 1000
}

// Settings constraints
const FOF_CACHE_MIN = 100
const FOF_CACHE_MAX = 5000

// Local state for settings component
let currentSettings = { ...DEFAULT_SETTINGS }
let settingsLoaded = false
let refreshUICallback = null

/**
 * Load settings from persistent storage
 * Settings are stored in {dataDir}/settings.json
 * @returns {Object} The loaded settings (merged with defaults)
 */
export function loadSettings() {
  try {
    const stored = localStorage.getItem('swarmnero_settings')
    if (stored) {
      const parsed = JSON.parse(stored)
      currentSettings = {
        ...DEFAULT_SETTINGS,
        ...parsed
      }
      settingsLoaded = true
      console.log('[Settings] Loaded settings:', currentSettings)
    }
  } catch (err) {
    console.warn('[Settings] Error loading settings:', err.message)
    currentSettings = { ...DEFAULT_SETTINGS }
  }
  return currentSettings
}

/**
 * Save settings to persistent storage
 * @param {Object} settings - Settings object to save
 */
export function saveSettings(settings) {
  try {
    currentSettings = {
      ...currentSettings,
      ...settings
    }
    localStorage.setItem('swarmnero_settings', JSON.stringify(currentSettings))
    console.log('[Settings] Saved settings:', currentSettings)
    return true
  } catch (err) {
    console.warn('[Settings] Error saving settings:', err.message)
    return false
  }
}

/**
 * Get current settings
 * @returns {Object} Current settings
 */
export function getSettings() {
  if (!settingsLoaded) {
    loadSettings()
  }
  return { ...currentSettings }
}

/**
 * Format a timestamp as a relative date string
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted date string
 */
function formatDate(timestamp) {
  if (!timestamp) return 'N/A'

  const date = new Date(timestamp)
  const now = new Date()
  const diff = now - date

  // If less than 24 hours, show relative time
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000)
    if (hours < 1) {
      const minutes = Math.floor(diff / 60000)
      return minutes <= 1 ? 'just now' : `${minutes} minutes ago`
    }
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }

  // If less than 7 days, show days ago
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000)
    return `${days} day${days === 1 ? '' : 's'} ago`
  }

  // Otherwise show date
  return date.toLocaleDateString()
}

/**
 * Get FoF cache statistics
 * @returns {Object} Cache stats { count, maxSize, oldestTimestamp }
 */
function getFoFCacheStats() {
  try {
    // Access FoF cache through state if available
    if (state.fofCache && typeof state.fofCache.getStats === 'function') {
      return state.fofCache.getStats()
    }

    // Fallback: return empty stats
    return {
      count: 0,
      maxSize: currentSettings.fofCacheSize || DEFAULT_SETTINGS.fofCacheSize,
      oldestTimestamp: null
    }
  } catch (err) {
    console.warn('[Settings] Error getting FoF cache stats:', err.message)
    return {
      count: 0,
      maxSize: currentSettings.fofCacheSize || DEFAULT_SETTINGS.fofCacheSize,
      oldestTimestamp: null
    }
  }
}

/**
 * Get HTML for sync status display
 */
function getSyncStatusHtml() {
  const syncActive = localStorage.getItem('swarmnero_sync_active') === 'true'
  const syncExpires = localStorage.getItem('swarmnero_sync_expires')
  const expiryDate = syncExpires ? new Date(parseInt(syncExpires)) : null
  const isConnected = state.syncClient?.isConnected || false

  const pubkey = state.identity?.pubkeyHex
  const isSupporter = pubkey ? getSupporterManager().isListed(pubkey) : false

  if (!syncActive) {
    if (!isSupporter) {
      return `
        <div class="sync-status-inactive">
          <span class="sync-indicator">Inactive</span>
          <span class="hint">Become a supporter to enable feed backup</span>
        </div>
      `
    }
    return `
      <div class="sync-status-inactive">
        <span class="sync-indicator">Inactive</span>
        <span class="hint">Backup is off. Your posts are only available while you're online.</span>
        <button id="enableSyncService" class="btn-small btn-primary">Enable Backup</button>
        <div id="syncToggleStatus" class="hint"></div>
      </div>
    `
  }

  const expiryStr = expiryDate ? expiryDate.toLocaleDateString() : 'Unknown'
  const connectionStr = isConnected ? 'Connected' : 'Connecting...'

  return `
    <div class="sync-status-active">
      <span class="sync-indicator active">Active</span>
      <span class="sync-detail">Server: ${connectionStr}</span>
      <span class="sync-detail">Expires: ${escapeHtml(expiryStr)}</span>
      <button id="refreshSyncStatus" class="btn-small">Refresh Status</button>
      <button id="disableSyncService" class="btn-small btn-danger">Disable</button>
      <div id="syncToggleStatus" class="hint"></div>
    </div>
  `
}

/**
 * Render the settings panel
 */
export function renderSettings() {
  const container = document.getElementById('settingsContent')
  if (!container) return

  // Ensure settings are loaded
  if (!settingsLoaded) {
    loadSettings()
  }

  // Get current FoF cache stats
  const cacheStats = getFoFCacheStats()
  const oldestDateStr = cacheStats.oldestTimestamp
    ? formatDate(cacheStats.oldestTimestamp)
    : 'N/A'

  container.innerHTML = `
    <div class="settings-container">
      <h3>Settings</h3>

      <div class="settings-section">
        <h4>Friend-of-Friend Discovery</h4>
        <p class="settings-description hint">
          FoF discovery caches posts from users your follows interact with,
          helping you discover new content.
        </p>

        <div class="setting-row">
          <label for="fofCacheSize">Cache Size</label>
          <div class="setting-input-group">
            <input
              type="number"
              id="fofCacheSize"
              min="${FOF_CACHE_MIN}"
              max="${FOF_CACHE_MAX}"
              value="${currentSettings.fofCacheSize}"
              class="setting-input"
            />
            <button id="saveFofCacheSize" class="btn-small btn-primary">Save</button>
          </div>
          <span class="hint">Maximum FoF posts to cache (${FOF_CACHE_MIN}-${FOF_CACHE_MAX})</span>
        </div>

        <div class="setting-row">
          <label>Cache Stats</label>
          <div class="cache-stats">
            <span class="stat-value">${cacheStats.count}</span> posts cached
            ${cacheStats.count > 0 ? `<span class="stat-separator">|</span> oldest from <span class="stat-value">${escapeHtml(oldestDateStr)}</span>` : ''}
          </div>
        </div>

        <div class="setting-row">
          <button id="clearFofCache" class="btn-danger">Clear FoF Cache</button>
          <span class="hint">Remove all cached friend-of-friend posts</span>
        </div>
      </div>

      <div class="settings-section">
        <h4>Feed Backup</h4>
        <p class="settings-description hint">
          Supporters can back up their feed to an always-online server so followers can access their posts 24/7.
        </p>
        <div class="setting-row" id="syncStatusRow">
          ${getSyncStatusHtml()}
        </div>
      </div>
    </div>
  `

  // Setup handlers after rendering
  setupSettingsHandlers()
}

/**
 * Setup event handlers for settings UI
 */
export function setupSettingsHandlers() {
  // Save FoF cache size button
  const saveCacheSizeBtn = document.getElementById('saveFofCacheSize')
  const cacheSizeInput = document.getElementById('fofCacheSize')

  if (saveCacheSizeBtn && cacheSizeInput) {
    saveCacheSizeBtn.addEventListener('click', () => {
      let newSize = parseInt(cacheSizeInput.value, 10)

      // Validate range
      if (isNaN(newSize)) {
        newSize = DEFAULT_SETTINGS.fofCacheSize
      } else if (newSize < FOF_CACHE_MIN) {
        newSize = FOF_CACHE_MIN
      } else if (newSize > FOF_CACHE_MAX) {
        newSize = FOF_CACHE_MAX
      }

      // Update input to show validated value
      cacheSizeInput.value = newSize

      // Save settings
      saveSettings({ fofCacheSize: newSize })

      // Apply to FoF cache if available
      if (state.fofCache && typeof state.fofCache.setMaxSize === 'function') {
        try {
          state.fofCache.setMaxSize(newSize)
        } catch (err) {
          console.warn('[Settings] Error updating FoF cache size:', err.message)
        }
      }

      // Show feedback
      const originalText = saveCacheSizeBtn.textContent
      saveCacheSizeBtn.textContent = 'Saved!'
      saveCacheSizeBtn.disabled = true
      setTimeout(() => {
        saveCacheSizeBtn.textContent = originalText
        saveCacheSizeBtn.disabled = false
      }, 1500)

      // Re-render to update stats
      renderSettings()
    })
  }

  // Clear FoF cache button
  const clearCacheBtn = document.getElementById('clearFofCache')
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', () => {
      // Show confirmation dialog
      const confirmed = confirm(
        'Are you sure you want to clear the FoF cache?\n\n' +
        'This will remove all cached friend-of-friend posts. ' +
        'New posts will be cached as they are discovered.'
      )

      if (!confirmed) return

      // Clear the cache
      if (state.fofCache && typeof state.fofCache.clear === 'function') {
        try {
          state.fofCache.clear()

          // Show feedback
          const originalText = clearCacheBtn.textContent
          clearCacheBtn.textContent = 'Cleared!'
          clearCacheBtn.disabled = true
          setTimeout(() => {
            clearCacheBtn.textContent = originalText
            clearCacheBtn.disabled = false
          }, 1500)

          // Re-render to update stats
          renderSettings()

          // Refresh UI if callback available
          if (refreshUICallback) {
            refreshUICallback()
          }
        } catch (err) {
          console.error('[Settings] Error clearing FoF cache:', err)
          alert('Error clearing cache: ' + err.message)
        }
      } else {
        // No cache available
        const originalText = clearCacheBtn.textContent
        clearCacheBtn.textContent = 'No cache'
        clearCacheBtn.disabled = true
        setTimeout(() => {
          clearCacheBtn.textContent = originalText
          clearCacheBtn.disabled = false
        }, 1500)
      }
    })
  }

  // Refresh sync status button
  const refreshSyncBtn = document.getElementById('refreshSyncStatus')
  if (refreshSyncBtn) {
    refreshSyncBtn.addEventListener('click', async () => {
      refreshSyncBtn.disabled = true
      refreshSyncBtn.textContent = '...'
      try {
        if (state.syncClient?.isConnected) {
          const status = await state.syncClient.requestStatus()
          if (status.active) {
            localStorage.setItem('swarmnero_sync_active', 'true')
            localStorage.setItem('swarmnero_sync_expires', status.expiresAt?.toString() || '')
          } else {
            localStorage.setItem('swarmnero_sync_active', 'false')
          }
        }
      } catch (err) {
        console.warn('[Settings] Sync status refresh error:', err.message)
      }
      renderSettings()
    })
  }

  // Disable sync service button — actually tells the server to stop
  const disableSyncBtn = document.getElementById('disableSyncService')
  if (disableSyncBtn) {
    disableSyncBtn.addEventListener('click', async () => {
      if (!confirm('Disable feed backup? Your posts will only be available when you are online.')) return
      const statusEl = document.getElementById('syncToggleStatus')
      disableSyncBtn.disabled = true
      disableSyncBtn.textContent = 'Disabling…'
      try {
        await runFeedBackupDisable({
          onStatus: (msg) => { if (statusEl) statusEl.textContent = msg }
        })
        renderSettings()
      } catch (err) {
        console.error('[Settings] Disable error:', err.message)
        if (statusEl) statusEl.textContent = err.message
        disableSyncBtn.disabled = false
        disableSyncBtn.textContent = 'Disable'
      }
    })
  }

  // Enable sync service button (shown when supporter but backup is off)
  const enableSyncBtn = document.getElementById('enableSyncService')
  if (enableSyncBtn) {
    enableSyncBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('syncToggleStatus')
      enableSyncBtn.disabled = true
      enableSyncBtn.textContent = 'Enabling…'
      try {
        await runFeedBackupPurchase({
          onStatus: (msg) => { if (statusEl) statusEl.textContent = msg }
        })
        renderSettings()
      } catch (err) {
        console.error('[Settings] Enable error:', err.message)
        if (statusEl) statusEl.textContent = err.message
        enableSyncBtn.disabled = false
        enableSyncBtn.textContent = 'Enable Backup'
      }
    })
  }
}

/**
 * Initialize settings component
 * @param {Function} refreshUI - Callback to refresh the main UI
 */
export function initSettings(refreshUI) {
  refreshUICallback = refreshUI

  // Load settings on init
  loadSettings()

  // Apply loaded settings to FoF cache if available
  if (state.fofCache && typeof state.fofCache.setMaxSize === 'function') {
    try {
      state.fofCache.setMaxSize(currentSettings.fofCacheSize)
    } catch (err) {
      console.warn('[Settings] Error applying initial FoF cache size:', err.message)
    }
  }

  console.log('[Settings] Initialized with settings:', currentSettings)
}
