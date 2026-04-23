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
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'

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
    this.lastPruneResult = null
    this._pruneInFlight = null
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

  /**
   * Auto-prune entry point. Skips if disabled or unlimited cap.
   * Safe to call from timers — concurrent calls coalesce.
   */
  async maybeRunPrune() {
    if (!this.config.autoPrune) return { skipped: true, reason: 'auto-prune disabled' }
    if (!this.config.capBytes || this.config.capBytes <= 0) {
      return { skipped: true, reason: 'cap unlimited' }
    }
    return this.runPrune()
  }

  /**
   * Run eviction until under 0.9 × cap (hysteresis band) or no more work is possible.
   * Keeps the most recent `keepPerFollow` blocks of each follow; clears the rest.
   * Never touches own feed.
   *
   * Re-indexes the kept blocks into tag-index so search still resolves to them.
   * Drops fof-cache entries for pruned authors (simpler than partial prune).
   *
   * Concurrent calls coalesce — the second call awaits the first's result.
   *
   * @returns {Promise<{
   *   skipped: boolean, reason?: string,
   *   startBytes: number, endBytes: number,
   *   followsTouched: number, blocksCleared: number,
   *   stillOverCap: boolean, ranAt: number
   * }>}
   */
  async runPrune() {
    if (this._pruneInFlight) return this._pruneInFlight
    this._pruneInFlight = this._runPruneInner()
    try {
      const result = await this._pruneInFlight
      this.lastPruneResult = result
      return result
    } finally {
      this._pruneInFlight = null
    }
  }

  async _runPruneInner() {
    const ranAt = Date.now()
    const cap = this.config.capBytes
    const keep = Math.max(1, this.config.keepPerFollow || DEFAULT_CONFIG.keepPerFollow)
    const floor = cap > 0 ? cap * 0.9 : Infinity

    const startSummary = await this.getSummary()
    const startBytes = startSummary.feedsBytes

    if (cap > 0 && startBytes <= floor) {
      // Under cap: skip post pruning but still sweep orphan peer media
      // so unfollowed-author drives get cleaned up over time.
      let media = null
      try {
        media = await this.runMediaSweep()
      } catch (err) {
        console.warn('[StorageManager] media sweep (under-cap) failed:', err.message)
        media = { skipped: true, reason: err.message, driveKeysScanned: 0, pathsCleared: 0, bytesCleared: 0, tookMs: 0 }
      }
      return {
        skipped: true, reason: 'under cap',
        startBytes, endBytes: startBytes,
        followsTouched: 0, blocksCleared: 0,
        stillOverCap: false, ranAt,
        media
      }
    }

    // Largest first so each iteration reclaims the most bytes
    const peers = [...startSummary.peers].sort((a, b) => b.bytes - a.bytes)
    let totalBytes = startBytes
    let followsTouched = 0
    let blocksCleared = 0

    for (const p of peers) {
      if (cap > 0 && totalBytes <= floor) break
      if (p.length <= keep) continue

      const peerCore = this.feed?.peers?.get(p.swarmId)
      if (!peerCore) continue

      const end = Math.max(0, peerCore.length - keep)
      if (end <= 0) continue

      const bytesBefore = await this._coreDiskBytes(peerCore)
      try {
        await this.feed.clearPeerBlocks(p.swarmId, 0, end)
      } catch (err) {
        console.warn(`[StorageManager] prune clear(${p.swarmId.slice(0, 8)}) failed:`, err.message)
        continue
      }
      const bytesAfter = await this._coreDiskBytes(peerCore)
      const freed = Math.max(0, bytesBefore - bytesAfter)
      totalBytes = Math.max(0, totalBytes - freed)
      followsTouched++
      blocksCleared += end

      if (p.pubkey) {
        try { this.tagIndex?.pruneByPubkey(p.pubkey) } catch {}
        try { this.fofCache?.pruneByPubkey(p.pubkey) } catch {}
        await this._reindexPeerKeptBlocks(p.swarmId, peerCore.length - keep, peerCore.length)
      }
    }

    // Phase 3: media sweep runs after post pruning so referenced-path
    // collection reflects only kept blocks.
    let media = null
    try {
      media = await this.runMediaSweep()
    } catch (err) {
      console.warn('[StorageManager] media sweep failed:', err.message)
      media = { skipped: true, reason: err.message, driveKeysScanned: 0, pathsCleared: 0, bytesCleared: 0, tookMs: 0 }
    }

    const stillOverCap = cap > 0 && totalBytes > floor
    const result = {
      skipped: false,
      startBytes, endBytes: totalBytes,
      followsTouched, blocksCleared,
      stillOverCap, ranAt,
      media
    }
    console.log('[StorageManager] prune complete', result)
    return result
  }

  /**
   * Re-read the kept block range for a follow and push signed posts with
   * tags back into the tag index, so search keeps working for kept posts.
   * @private
   */
  async _reindexPeerKeptBlocks(swarmId, start, end) {
    if (!this.tagIndex || !this.feed || end <= start) return
    try {
      const events = await this.feed.readPeer(swarmId, start, end)
      const posts = events.filter(e =>
        e && e.type === 'post' && Array.isArray(e.tags) && e.tags.length > 0
      )
      if (posts.length > 0) {
        this.tagIndex.indexPostsBatch(posts, 'following')
      }
    } catch (err) {
      console.warn('[StorageManager] _reindexPeerKeptBlocks failed:', err.message)
    }
  }

  /**
   * Peer-drive media sweep.
   *
   * Walks own feed + all kept peer feeds to build
   *   referenced: Map<driveKeyHex, Set<path>>
   *
   * Then for each peer drive to sweep — drives referenced in current posts
   * plus drives still open in the media LRU cache — iterates entries and
   * calls drive.clear(path) for anything not in the keep-set. Peer drives
   * opened only for the sweep are closed after.
   *
   * The own drive is never touched (DM-referenced paths would require
   * decrypting DM cores to enumerate safely; out of scope for Phase 3).
   *
   * @returns {Promise<{
   *   skipped: boolean, reason?: string,
   *   driveKeysScanned: number,
   *   pathsCleared: number,
   *   bytesCleared: number,
   *   tookMs: number
   * }>}
   */
  async runMediaSweep() {
    const started = Date.now()
    const media = this.state?.media
    if (!media?.store || !media?.driveKey) {
      return { skipped: true, reason: 'media not initialized', driveKeysScanned: 0, pathsCleared: 0, bytesCleared: 0, tookMs: 0 }
    }
    if (!this.feed) {
      return { skipped: true, reason: 'feed not initialized', driveKeysScanned: 0, pathsCleared: 0, bytesCleared: 0, tookMs: 0 }
    }

    const ownDriveKey = media.driveKey.toLowerCase()
    const referenced = new Map() // driveKeyHex -> Set<path>

    const collectFromEvents = (events) => {
      for (const ev of events) {
        if (!ev || !Array.isArray(ev.media)) continue
        for (const m of ev.media) {
          if (!m || typeof m.path !== 'string' || typeof m.driveKey !== 'string') continue
          if (!/^[a-f0-9]{64}$/i.test(m.driveKey)) continue
          const key = m.driveKey.toLowerCase()
          if (!referenced.has(key)) referenced.set(key, new Set())
          referenced.get(key).add(m.path)
        }
      }
    }

    try {
      const ownEvents = await this.feed.read(0, this.feed.core.length)
      collectFromEvents(ownEvents)
    } catch (err) {
      console.warn('[StorageManager] media sweep: own-feed scan failed:', err.message)
    }

    for (const [swarmId, peerCore] of this.feed.peers) {
      try {
        const events = await this.feed.readPeer(swarmId, 0, peerCore.length)
        collectFromEvents(events)
      } catch (err) {
        console.warn(`[StorageManager] media sweep: peer ${swarmId.slice(0, 8)} scan failed:`, err.message)
      }
    }

    // Drives to sweep: referenced (still used) + currently-open (LRU cache).
    // An open-but-not-referenced drive means we cached its media but all
    // referencing posts are gone — safe to clear entirely.
    const driveKeysToSweep = new Set()
    for (const key of referenced.keys()) {
      if (key !== ownDriveKey) driveKeysToSweep.add(key)
    }
    for (const key of media.peerDrives.keys()) {
      const normalized = key.toLowerCase()
      if (normalized !== ownDriveKey) driveKeysToSweep.add(normalized)
    }

    let driveKeysScanned = 0
    let pathsCleared = 0
    let bytesCleared = 0

    for (const driveKey of driveKeysToSweep) {
      const keepPaths = referenced.get(driveKey) || new Set()
      const res = await this._sweepPeerDrive(driveKey, keepPaths, media)
      if (res) {
        driveKeysScanned++
        pathsCleared += res.pathsCleared
        bytesCleared += res.bytesCleared
      }
    }

    return {
      skipped: false,
      driveKeysScanned,
      pathsCleared,
      bytesCleared,
      tookMs: Date.now() - started
    }
  }

  async _sweepPeerDrive(driveKeyHex, keepPaths, media) {
    let peerDrive = media.peerDrives.get(driveKeyHex)
    let weOpened = false

    try {
      if (!peerDrive) {
        const driveKeyBuf = b4a.from(driveKeyHex, 'hex')
        peerDrive = new Hyperdrive(media.store.namespace('media'), driveKeyBuf)
        try {
          // Short timeout — purely local enumeration; don't wait for network.
          await Promise.race([
            peerDrive.ready(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ready timeout')), 5000))
          ])
        } catch (err) {
          console.warn(`[StorageManager] open drive ${driveKeyHex.slice(0, 8)} failed:`, err.message)
          try { await peerDrive.close() } catch {}
          return null
        }
        weOpened = true
      }

      let pathsCleared = 0
      let bytesCleared = 0
      const entries = []

      try {
        // Iterate local entries. No update() so we only see what we already have.
        const stream = peerDrive.entries()
        const iterator = stream[Symbol.asyncIterator]()
        const startTime = Date.now()
        while (true) {
          if (Date.now() - startTime > 10_000) {
            console.warn(`[StorageManager] entries() iteration exceeded 10s for drive ${driveKeyHex.slice(0, 8)}`)
            break
          }
          const step = await iterator.next()
          if (step.done) break
          if (step.value) entries.push(step.value)
        }
      } catch (err) {
        console.warn(`[StorageManager] entries() failed for drive ${driveKeyHex.slice(0, 8)}:`, err.message)
      }

      for (const entry of entries) {
        const entryKey = entry?.key
        if (typeof entryKey !== 'string') continue
        if (keepPaths.has(entryKey)) continue

        const blobSize = entry?.value?.blob?.byteLength || 0
        try {
          await peerDrive.clear(entryKey)
          pathsCleared++
          bytesCleared += blobSize
        } catch (err) {
          console.warn(`[StorageManager] clear(${entryKey}) on ${driveKeyHex.slice(0, 8)} failed:`, err.message)
        }
      }

      return { pathsCleared, bytesCleared }
    } finally {
      if (weOpened && peerDrive) {
        try { await peerDrive.close() } catch {}
      }
    }
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
