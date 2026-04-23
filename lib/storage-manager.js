/**
 * StorageManager
 *
 * Tracks local disk usage of the account's Corestore + Hyperdrive,
 * exposes per-follow sizes, and clears a follow's cached blocks on request.
 *
 * Phase 1 (this file):
 *   - Read-only stats (own feed, per-follow, on-disk totals)
 *   - Manual clearPeer(swarmId) with tag-index + fof-cache prune hooks
 *   - Load/save cap + keepPerFollow config (consumed in Phase 2 auto-prune)
 *
 * Phase 2 (future): enforceCap() runs the eviction loop.
 */

import fs from 'fs'
import path from 'path'

const CONFIG_FILENAME = 'storage-config.json'

const DEFAULT_CONFIG = {
  capBytes: 1024 * 1024 * 1024, // 1 GB
  keepPerFollow: 200,
  autoPrune: true
}

export class StorageManager {
  /**
   * @param {Object} opts
   * @param {import('./feed.js').Feed} opts.feed
   * @param {string} opts.dataDir
   * @param {Object} [opts.tagIndex]   - tag-index instance (optional, used for prune hooks)
   * @param {Object} [opts.fofCache]   - fof-cache instance (optional, used for prune hooks)
   * @param {Object} [opts.state]      - app state for swarmId <-> pubkey + profile lookups
   */
  constructor({ feed, dataDir, tagIndex = null, fofCache = null, state = null }) {
    this.feed = feed
    this.dataDir = dataDir
    this.tagIndex = tagIndex
    this.fofCache = fofCache
    this.state = state
    this.config = { ...DEFAULT_CONFIG }
    this.configPath = path.join(dataDir, CONFIG_FILENAME)
  }

  /**
   * Load persisted config. Missing or corrupt file → DEFAULT_CONFIG.
   */
  loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.config = { ...DEFAULT_CONFIG }
        return this.config
      }
      const raw = fs.readFileSync(this.configPath, 'utf8')
      const parsed = JSON.parse(raw)
      this.config = { ...DEFAULT_CONFIG, ...parsed }
    } catch (err) {
      console.warn('[StorageManager] loadConfig failed, using defaults:', err.message)
      this.config = { ...DEFAULT_CONFIG }
    }
    return this.config
  }

  /**
   * Persist config atomically (write-to-temp + rename).
   */
  saveConfig(updates = {}) {
    this.config = { ...this.config, ...updates }
    const tmp = this.configPath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2))
    fs.renameSync(tmp, this.configPath)
    return this.config
  }

  /**
   * Sum of per-core storage components reported by Hypercore's Info API.
   * This reflects ACTUAL on-disk bytes (oplog + tree + blocks + bitfield),
   * so it shrinks after `core.clear()` — unlike byteLength.
   * @private
   */
  async _coreDiskBytes(core) {
    if (!core) return 0
    try {
      const info = await core.info({ storage: true })
      const s = info?.storage
      if (!s) return core.byteLength || 0
      return (s.oplog || 0) + (s.tree || 0) + (s.blocks || 0) + (s.bitfield || 0)
    } catch {
      return core.byteLength || 0
    }
  }

  /**
   * Own feed size on disk.
   * @returns {Promise<{ bytes: number, length: number }>}
   */
  async getOwnSize() {
    const core = this.feed?.core
    if (!core) return { bytes: 0, length: 0 }
    const bytes = await this._coreDiskBytes(core)
    return { bytes, length: core.length || 0 }
  }

  /**
   * Per-follow sizes sorted largest first. Uses real on-disk storage size.
   * @returns {Promise<Array<{ swarmId: string, pubkey: string|null, name: string|null,
   *                           bytes: number, length: number }>>}
   */
  async getPeerSizes() {
    if (!this.feed?.peers) return []

    const entries = []
    for (const [swarmId, peerCore] of this.feed.peers) {
      entries.push({ swarmId, peerCore })
    }

    const sizes = await Promise.all(entries.map(e => this._coreDiskBytes(e.peerCore)))

    const result = entries.map(({ swarmId, peerCore }, i) => {
      const pubkey = this.state?.swarmIdToPubkey?.[swarmId] || null
      const profile = pubkey ? this.state?.peerProfiles?.[pubkey] : null
      return {
        swarmId,
        pubkey,
        name: profile?.name || null,
        bytes: sizes[i],
        length: peerCore.length || 0
      }
    })

    result.sort((a, b) => b.bytes - a.bytes)
    return result
  }

  /**
   * Authoritative on-disk usage: walks the data directory and sums file sizes.
   *   cores  = Corestore directory (feeds + Hyperdrive media live in namespaces here)
   *   index  = known cache files (tag-index, fof-cache, peer-profiles, followers)
   *   other  = everything else in dataDir (wallet, identity, config, etc.)
   * @returns {Promise<{ total: number, cores: number, index: number, other: number }>}
   */
  async getTotalOnDisk() {
    const dataDir = this.dataDir
    const [cores, index, total] = await Promise.all([
      this._dirSize(path.join(dataDir, 'cores')),
      this._indexFilesSize(dataDir),
      this._dirSize(dataDir)
    ])
    return {
      total,
      cores,
      index,
      other: Math.max(0, total - cores - index)
    }
  }

  /**
   * Per-follow disk sizes + own feed disk size + current config, rolled up
   * for the UI summary. Uses real on-disk bytes from Hypercore's info API.
   */
  async getSummary() {
    const [own, peers] = await Promise.all([this.getOwnSize(), this.getPeerSizes()])
    const peersBytes = peers.reduce((s, p) => s + p.bytes, 0)
    return {
      own,
      peers,
      peerCount: peers.length,
      feedsBytes: own.bytes + peersBytes,
      capBytes: this.config.capBytes,
      keepPerFollow: this.config.keepPerFollow,
      autoPrune: this.config.autoPrune
    }
  }

  /**
   * Clear all downloaded blocks for a single follow, then prune related caches.
   * Doesn't unfollow — the feed core, its key, and the swarm topic stay active
   * so blocks re-fetch on demand when the user browses the author's profile
   * or scrolls to an older timeline range.
   *
   * @param {string} swarmId
   * @returns {Promise<{ cleared: number, bytesEstimated: number }>}
   */
  async clearPeer(swarmId) {
    const peerCore = this.feed?.peers?.get(swarmId)
    const bytesBefore = peerCore ? await this._coreDiskBytes(peerCore) : 0

    const result = await this.feed.clearPeerBlocks(swarmId)

    const bytesAfter = peerCore ? await this._coreDiskBytes(peerCore) : 0
    result.bytesEstimated = Math.max(0, bytesBefore - bytesAfter)

    const pubkey = this.state?.swarmIdToPubkey?.[swarmId]
    if (pubkey) {
      if (this.tagIndex?.pruneByPubkey) {
        try { this.tagIndex.pruneByPubkey(pubkey) } catch (err) {
          console.warn('[StorageManager] tagIndex prune failed:', err.message)
        }
      }
      if (this.fofCache?.pruneByPubkey) {
        try { this.fofCache.pruneByPubkey(pubkey) } catch (err) {
          console.warn('[StorageManager] fofCache prune failed:', err.message)
        }
      }
    }

    return result
  }

  /**
   * Clear all follows' cached feeds.
   * @returns {Promise<{ followsCleared: number, blocksCleared: number, bytesEstimated: number }>}
   */
  async clearAllPeers() {
    const peers = await this.getPeerSizes()
    let followsCleared = 0
    let blocksCleared = 0
    let bytesEstimated = 0

    for (const p of peers) {
      try {
        const res = await this.clearPeer(p.swarmId)
        if (res.cleared > 0) {
          followsCleared++
          blocksCleared += res.cleared
          bytesEstimated += res.bytesEstimated
        }
      } catch (err) {
        console.warn(`[StorageManager] clearPeer(${p.swarmId.slice(0, 8)}) failed:`, err.message)
      }
    }

    return { followsCleared, blocksCleared, bytesEstimated }
  }

  // --- internal ---

  async _dirSize(dir) {
    let total = 0
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        try {
          if (entry.isDirectory()) {
            total += await this._dirSize(full)
          } else if (entry.isFile()) {
            const st = await fs.promises.stat(full)
            total += st.size
          }
        } catch { /* ignore per-entry errors */ }
      }
    } catch {
      // dir doesn't exist — size 0
    }
    return total
  }

  async _indexFilesSize(dir) {
    // Index/cache files live at dataDir root, not in a subdirectory.
    // Include the known ones so "Index & overhead" is meaningful.
    const patterns = [
      /^tag-index(-[a-f0-9]+)?\.json$/,
      /^fof-cache(-[a-f0-9]+)?\.json$/,
      /^peer-profiles(-[a-f0-9]+)?\.json$/,
      /^followers-[a-f0-9]+\.json$/
    ]
    let total = 0
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!patterns.some(p => p.test(entry.name))) continue
        try {
          const st = await fs.promises.stat(path.join(dir, entry.name))
          total += st.size
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return total
  }
}

export function formatBytes(bytes) {
  if (bytes == null || !isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
