/**
 * TipBatcher - Delays tip event broadcasts for privacy
 *
 * Purpose: Break timing correlation between Monero transactions and swarm activity.
 * When a tip is sent, the on-chain transaction is immediate, but the public announcement
 * is delayed and batched with other tips to prevent observers from correlating
 * IP addresses with specific blockchain transactions.
 *
 * Features:
 * - Persists pending tips to disk (survives app crashes)
 * - 6-hour batch interval with shuffled order
 * - Loads and resumes on startup
 * - Flushes stale tips on startup if batch interval passed
 */

import fs from 'fs'
import path from 'path'

// Default batch interval: 6 hours
const DEFAULT_BATCH_INTERVAL = 6 * 60 * 60 * 1000

export class TipBatcher {
  /**
   * @param {Object} feed - Feed instance for appending events
   * @param {string} dataDir - Directory for persistence
   * @param {number} batchInterval - Interval between flushes (default 6 hours)
   */
  constructor(feed, dataDir, batchInterval = DEFAULT_BATCH_INTERVAL) {
    this.feed = feed
    this.dataDir = dataDir
    this.storagePath = path.join(dataDir, 'pending-tips.json')
    this.batchInterval = batchInterval
    this.pending = this._loadFromDisk()
    this._intervalId = null
  }

  /**
   * Initialize the batcher - start the flush interval
   */
  init() {
    // Check if we have stale tips from a previous session
    this._checkStartupFlush()

    // Start the periodic flush interval
    this._intervalId = setInterval(() => this._flush(), this.batchInterval)

    console.log(`[TipBatcher] Initialized with ${this.pending.length} pending tips, interval: ${this.batchInterval / 1000 / 60} minutes`)
    return this
  }

  /**
   * Check if pending tips are old enough to flush immediately on startup
   */
  _checkStartupFlush() {
    if (this.pending.length === 0) return

    const oldest = Math.min(...this.pending.map(t => t.queuedAt))
    const age = Date.now() - oldest

    if (age >= this.batchInterval) {
      console.log(`[TipBatcher] Found stale tips from previous session (${Math.floor(age / 1000 / 60)} minutes old), flushing now`)
      this._flush()
    } else {
      const remainingMs = this.batchInterval - age
      console.log(`[TipBatcher] ${this.pending.length} pending tips, next flush in ${Math.floor(remainingMs / 1000 / 60)} minutes`)
    }
  }

  /**
   * Queue a tip event for delayed broadcast
   * @param {Object} tipEvent - The tip event to broadcast later
   */
  queue(tipEvent) {
    const entry = {
      ...tipEvent,
      queuedAt: Date.now()
    }

    this.pending.push(entry)
    this._saveToDisk()

    console.log(`[TipBatcher] Queued tip, ${this.pending.length} pending (will broadcast in up to ${this.batchInterval / 1000 / 60} minutes)`)
  }

  /**
   * Flush all pending tips to the feed
   * Shuffles order to break any remaining correlation
   */
  async _flush() {
    if (this.pending.length === 0) return

    console.log(`[TipBatcher] Flushing ${this.pending.length} tips`)

    // Shuffle to break ordering correlation
    const shuffled = [...this.pending].sort(() => Math.random() - 0.5)

    const failed = []

    for (const entry of shuffled) {
      try {
        // Remove internal metadata before appending
        const { queuedAt, ...tipEvent } = entry
        await this.feed.append(tipEvent)
        console.log(`[TipBatcher] Broadcast tip: ${tipEvent.amount} to ${tipEvent.to_swarm_id?.slice(0, 8)}...`)
      } catch (err) {
        console.error(`[TipBatcher] Failed to append tip: ${err.message}`)
        failed.push(entry)
      }
    }

    // Keep only failed tips for retry
    this.pending = failed
    this._saveToDisk()

    if (failed.length > 0) {
      console.warn(`[TipBatcher] ${failed.length} tips failed, will retry next batch`)
    } else {
      console.log('[TipBatcher] All tips broadcast successfully')
    }
  }

  /**
   * Force flush all pending tips immediately
   * Use with caution - breaks timing privacy
   */
  async forceFlush() {
    console.log('[TipBatcher] Force flushing all pending tips')
    await this._flush()
  }

  /**
   * Get count of pending tips
   */
  getPendingCount() {
    return this.pending.length
  }

  /**
   * Save pending tips to disk
   */
  _saveToDisk() {
    try {
      fs.writeFileSync(this.storagePath, JSON.stringify(this.pending, null, 2), 'utf8')
    } catch (err) {
      console.error(`[TipBatcher] Failed to save to disk: ${err.message}`)
    }
  }

  /**
   * Load pending tips from disk
   */
  _loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf8')
        const parsed = JSON.parse(data)
        if (Array.isArray(parsed)) {
          return parsed
        }
      }
    } catch (err) {
      console.error(`[TipBatcher] Failed to load from disk: ${err.message}`)
    }
    return []
  }

  /**
   * Clean up - stop interval and save state
   */
  destroy() {
    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    this._saveToDisk()
    console.log(`[TipBatcher] Destroyed, ${this.pending.length} tips saved for next session`)
  }
}
