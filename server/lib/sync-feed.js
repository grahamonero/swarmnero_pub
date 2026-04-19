/**
 * Sync Feed - Simplified feed management for the sync server
 * Handles Corestore + Hyperswarm for replicating supporter feeds
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

export class SyncFeed {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.store = null
    this.swarm = null
    this.peers = new Map() // swarmId -> core
    this.syncStats = new Map() // swarmId -> { lastDownloadAt, blockCount, lastConnectedAt }
    this.onConnection = null // callback for new connections
  }

  async init(identity) {
    this.store = new Corestore(this.dataDir + '/cores')

    // Create server's own core (makes the server discoverable by swarmId)
    this.core = this.store.get({ name: `feed-${identity.pubkeyHex}` })
    await this.core.ready()

    this.swarm = new Hyperswarm()

    this.swarm.on('connection', (conn, info) => {
      console.log('[SyncFeed] New connection, topics:', info.topics?.length || 0)

      // Replicate all cores over every connection
      this.store.replicate(conn)

      if (this.onConnection) {
        this.onConnection(conn, info)
      }

      conn.on('error', (err) => {
        console.warn('[SyncFeed] Connection error:', err.message)
      })
    })

    // Join swarm with our own core's discovery key
    this.swarm.join(this.core.discoveryKey)
    await this.swarm.flush()

    console.log(`[SyncFeed] Initialized, swarmId: ${this.swarmId}`)
    return this
  }

  /**
   * Get the server's swarm ID (for clients to follow)
   */
  get swarmId() {
    return this.core ? b4a.toString(this.core.key, 'hex') : null
  }

  /**
   * Follow a supporter's feed by their swarmId
   * @param {string} swarmIdHex - Supporter's Hypercore public key (hex)
   */
  async follow(swarmIdHex) {
    if (this.peers.has(swarmIdHex)) return // Already following

    const swarmIdKey = b4a.from(swarmIdHex, 'hex')
    const peerCore = this.store.get({ key: swarmIdKey })
    await peerCore.ready()

    // Initialize stats for this supporter
    if (!this.syncStats.has(swarmIdHex)) {
      this.syncStats.set(swarmIdHex, {
        lastDownloadAt: null,
        blockCount: peerCore.length || 0,
        lastConnectedAt: null
      })
    }

    // Download all blocks eagerly so we can serve them to other peers
    peerCore.download({ start: 0, end: -1 })

    // Track download events to know when blocks arrive
    peerCore.on('download', () => {
      const stats = this.syncStats.get(swarmIdHex)
      if (stats) {
        stats.lastDownloadAt = Date.now()
        stats.blockCount = peerCore.length
      }
    })

    // Re-download on new data
    peerCore.on('append', () => {
      peerCore.download({ start: 0, end: -1 })
      const stats = this.syncStats.get(swarmIdHex)
      if (stats) {
        stats.lastDownloadAt = Date.now()
        stats.blockCount = peerCore.length
      }
    })

    // Track peer connection state for this core
    peerCore.on('peer-add', () => {
      const stats = this.syncStats.get(swarmIdHex)
      if (stats) {
        stats.lastConnectedAt = Date.now()
      }
    })

    this.peers.set(swarmIdHex, peerCore)

    this.swarm.join(peerCore.discoveryKey)
    await this.swarm.flush()

    console.log(`[SyncFeed] Following ${swarmIdHex.slice(0, 16)}...`)
    return peerCore
  }

  /**
   * Unfollow a supporter - stop replicating their feed
   * @param {string} swarmIdHex - Supporter's swarmId
   */
  async unfollow(swarmIdHex) {
    const peerCore = this.peers.get(swarmIdHex)
    if (!peerCore) return

    await this.swarm.leave(peerCore.discoveryKey)
    this.peers.delete(swarmIdHex)
    this.syncStats.delete(swarmIdHex)

    console.log(`[SyncFeed] Unfollowed ${swarmIdHex.slice(0, 16)}...`)
  }

  /**
   * Drop all locally stored blocks for a supporter's feed and stop replicating.
   * Used when an account exceeds its storage quota.
   * @param {string} swarmIdHex - Supporter's swarmId
   * @returns {Promise<number>} bytes freed (approximate)
   */
  async clearStorage(swarmIdHex) {
    const peerCore = this.peers.get(swarmIdHex)
    const freed = peerCore?.byteLength || 0

    if (peerCore) {
      try {
        if (typeof peerCore.clear === 'function' && peerCore.length > 0) {
          await peerCore.clear(0, peerCore.length)
        }
      } catch (err) {
        console.warn(`[SyncFeed] clear failed for ${swarmIdHex.slice(0, 16)}: ${err.message}`)
      }
    }

    await this.unfollow(swarmIdHex)
    console.log(`[SyncFeed] Cleared storage for ${swarmIdHex.slice(0, 16)}... freed=${freed} bytes`)
    return freed
  }

  /**
   * Get storage usage for a supporter's feed in bytes
   * @param {string} swarmIdHex - Supporter's swarmId
   * @returns {number} Bytes used
   */
  getStorageUsed(swarmIdHex) {
    const peerCore = this.peers.get(swarmIdHex)
    if (!peerCore) return 0
    return peerCore.byteLength || 0
  }

  /**
   * Get sync stats for a supporter's feed
   * @param {string} swarmIdHex - Supporter's swarmId
   * @returns {Object} Stats: blockCount, lastDownloadAt, lastConnectedAt, peerConnected
   */
  getSyncStats(swarmIdHex) {
    const peerCore = this.peers.get(swarmIdHex)
    const stats = this.syncStats.get(swarmIdHex)
    if (!peerCore || !stats) {
      return {
        blockCount: 0,
        lastDownloadAt: null,
        lastConnectedAt: null,
        peerConnected: false
      }
    }
    return {
      blockCount: peerCore.length || 0,
      lastDownloadAt: stats.lastDownloadAt,
      lastConnectedAt: stats.lastConnectedAt,
      peerConnected: (peerCore.peers?.length || 0) > 0
    }
  }

  async close() {
    for (const [swarmId, core] of this.peers) {
      try {
        await this.swarm.leave(core.discoveryKey)
      } catch (err) {
        console.warn(`[SyncFeed] Error leaving topic for ${swarmId.slice(0, 8)}:`, err.message)
      }
    }
    this.peers.clear()

    if (this.swarm) {
      await this.swarm.destroy()
      this.swarm = null
    }

    if (this.store) {
      await this.store.close()
      this.store = null
    }

    console.log('[SyncFeed] Closed')
  }
}
