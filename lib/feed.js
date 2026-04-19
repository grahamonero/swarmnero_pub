import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import { verify, hexToPubkey } from './identity.js'
import { DISCOVERY_TOPIC } from './discovery.js'

// Timeout for core.update() to prevent hanging on unreachable peers
const CORE_UPDATE_TIMEOUT = 15000

function updateWithTimeout(core, timeout = CORE_UPDATE_TIMEOUT) {
  return Promise.race([
    core.update(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('update timeout')), timeout))
  ]).catch(() => {}) // Silently continue with cached data
}

function getWithTimeout(core, index, timeout = CORE_UPDATE_TIMEOUT) {
  return Promise.race([
    core.get(index),
    new Promise((resolve) => setTimeout(() => resolve(null), timeout))
  ])
}

/**
 * Verify an event's signature
 * Returns true if valid, false if invalid or missing signature
 * Exported for use by FoF protocol
 */
export function verifyEventSignature(event) {
  if (!event.signature || !event.pubkey) {
    return false
  }

  try {
    // Reconstruct the signed message (event without signature)
    const { signature, ...eventWithoutSig } = event
    const message = JSON.stringify(eventWithoutSig)

    // Convert hex strings to buffers
    const signatureBuffer = b4a.from(signature, 'hex')
    const publicKeyBuffer = hexToPubkey(event.pubkey)

    return verify(message, signatureBuffer, publicKeyBuffer)
  } catch (err) {
    console.warn('Signature verification error:', err.message)
    return false
  }
}

/**
 * Feed management - Hypercore append-only log for user events
 */
export class Feed {
  constructor(dataDir, identity) {
    this.dataDir = dataDir
    this.identity = identity
    this.store = null
    this.core = null
    this.swarm = null
    this.peers = new Map() // swarmId -> core (users WE follow)
    this.followers = new Set() // swarmIds of users who follow US
    this.myTopics = new Set() // Topics we've joined (our feed + follows) - hex strings
    this.relevantConns = new Set() // Connections for our topics (not other accounts' cores)
    this.infrastructureTopics = new Set() // Discovery key hex strings for infrastructure peers (sync server)
    this.infrastructureHosts = new Set() // IP addresses of infrastructure peers (sync server VPS)
    this.onPeerUpdate = null // callback for peer count changes
    this.onDataUpdate = null // callback for new data (replaces polling)
    this.fof = null // FoF protocol handler, set externally after construction
    this.replyNotify = null // Reply notification protocol handler

    // Verified (pubkey -> { swarmId, timestamp }) bindings learned from signed
    // profile events. Only events that pass signature verification AND declare
    // a well-formed swarmId field are accepted. Later events replace earlier.
    this.verifiedBindings = new Map()
  }

  /**
   * Ingest a signed profile event and, if it declares a swarmId and verifies,
   * record the pubkey -> swarmId binding. Returns true if a new/updated
   * binding was recorded.
   *
   * The signature proves the holder of `event.pubkey` asserts that their feed
   * lives at `event.swarmId`. This lets any forwarder (FoF, gossip) relay the
   * event without being able to lie about the binding — the receiver verifies
   * the signature locally.
   */
  ingestSignedProfile(event) {
    if (!event || event.type !== 'profile') return false
    if (typeof event.pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(event.pubkey)) return false
    if (typeof event.swarmId !== 'string' || !/^[a-f0-9]{64}$/i.test(event.swarmId)) return false
    if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) return false
    if (!verifyEventSignature(event)) return false

    const existing = this.verifiedBindings.get(event.pubkey)
    if (existing && existing.timestamp >= event.timestamp) return false

    this.verifiedBindings.set(event.pubkey, {
      swarmId: event.swarmId.toLowerCase(),
      timestamp: event.timestamp
    })
    return true
  }

  /**
   * Get the verified swarmId for a given pubkey, or null if we have no
   * cryptographically verified binding yet.
   */
  getVerifiedSwarmId(pubkeyHex) {
    const entry = this.verifiedBindings.get(pubkeyHex)
    return entry ? entry.swarmId : null
  }

  /**
   * Mark a topic as belonging to infrastructure (e.g. sync server).
   * Connections on this topic will be flagged with conn._isInfrastructure = true
   * so that user-facing protocols (FoF, DM, Discovery, ReplyNotify) skip them.
   * @param {string} discoveryKeyHex - Hex-encoded discovery key
   */
  markInfrastructureTopic(discoveryKeyHex) {
    if (!discoveryKeyHex) return
    this.infrastructureTopics.add(discoveryKeyHex)
    // Mark any existing connections retroactively
    if (this.swarm?.connections) {
      for (const conn of this.swarm.connections) {
        if (conn._topics) {
          for (const t of conn._topics) {
            if (b4a.toString(t, 'hex') === discoveryKeyHex) {
              conn._isInfrastructure = true
              break
            }
          }
        }
      }
    }
  }

  /**
   * Mark a remote host (IP) as belonging to infrastructure (e.g. sync server).
   * Connections to this host will be flagged with conn._isInfrastructure = true.
   * @param {string} host - IP address (e.g. '206.245.132.26')
   */
  markInfrastructureHost(host) {
    if (!host) return
    this.infrastructureHosts.add(host)
    // Mark any existing connections retroactively
    if (this.swarm?.connections) {
      for (const conn of this.swarm.connections) {
        const remoteHost = conn.rawStream?.remoteHost
        if (remoteHost === host) {
          conn._isInfrastructure = true
        }
      }
    }
  }

  /**
   * Set the FoF protocol handler
   * @param {Object} fof - FoF instance
   */
  setFoF(fof) {
    this.fof = fof
  }

  /**
   * Set the ReplyNotify protocol handler
   * @param {Object} replyNotify - ReplyNotify instance
   */
  setReplyNotify(replyNotify) {
    this.replyNotify = replyNotify
  }

  async init() {
    this.store = new Corestore(this.dataDir + '/cores')

    // Each account gets its own Hypercore namespaced by identity
    this.core = this.store.get({ name: `feed-${this.identity.pubkeyHex}` })
    await this.core.ready()

    // Listen for new data on our own feed
    this.core.on('append', () => {
      if (this.onDataUpdate) this.onDataUpdate()
    })

    // Initialize swarm for P2P
    this.swarm = new Hyperswarm()

    // Handle new connections
    this.swarm.on('connection', (conn, info) => {
      // Check if this connection is ONLY for discovery (no feed replication needed)
      const hasDiscoveryTopic = info.topics?.some(t => b4a.equals(t, DISCOVERY_TOPIC))
      const hasOnlyDiscovery = info.topics?.length === 1 && hasDiscoveryTopic

      // Check if this connection is to an infrastructure peer (e.g. sync server)
      // Mark it so user-facing protocols (FoF, DM, Discovery) skip it
      const isInfraTopic = info.topics?.some(t => this.infrastructureTopics.has(b4a.toString(t, 'hex')))
      const remoteHost = conn.rawStream?.remoteHost
      const isInfraHost = remoteHost && this.infrastructureHosts.has(remoteHost)
      if (isInfraTopic || isInfraHost) {
        conn._isInfrastructure = true
      }

      // Stash topics on the connection for later marking (used by markInfrastructureTopic)
      conn._topics = info.topics

      // Check if connection includes any of OUR topics (our feed or feeds we follow)
      const hasOurTopic = info.topics?.some(t => this.myTopics.has(b4a.toString(t, 'hex')))

      // info.client: true = we connected to them, false = they connected to us
      // If they connected to us (we're server), they're a follower replicating our feed
      const theyConnectedToUs = info.client === false
      const isRelevant = hasOurTopic || theyConnectedToUs

      if (!hasOnlyDiscovery) {
        // Replicate for all non-discovery connections (helps the network)
        this.store.replicate(conn)

        // Count as "our peer" if it's for our topics OR they connected to us (they're a follower)
        if (isRelevant) {
          this.relevantConns.add(conn)
          conn.once('close', () => {
            this.relevantConns.delete(conn)
            if (this.onPeerUpdate) this.onPeerUpdate()
          })

          // Trigger FoF request for connections to followed peers
          // FoF now handles follower announcements - senderSwarmId + isFollowing in request
          if (this.fof && hasOurTopic) {
            // Request FoF data from this peer
            this.fof.requestFoF(conn)
          }
        }
      }
      if (this.onPeerUpdate) this.onPeerUpdate()
    })

    // Join swarm with our feed's discovery key
    const myDiscoveryKeyHex = b4a.toString(this.core.discoveryKey, 'hex')
    this.myTopics.add(myDiscoveryKeyHex)
    this.swarm.join(this.core.discoveryKey)
    await this.swarm.flush()

    // Restore followed peers from stored events
    await this.restoreFollowing()

    // Load cached followers from disk
    await this._loadFollowers()

    // Update followers from peer feeds (async, non-blocking)
    // This refreshes the follower list based on actual feed data
    this.updateFollowers().catch(err => {
      console.warn('[Feed] Error updating followers:', err.message)
    })

    return this
  }

  /**
   * Restore followed peers from stored follow/unfollow events
   */
  async restoreFollowing() {
    const events = await this.read()
    const following = new Set()
    const HEX64_RE = /^[a-f0-9]{64}$/i

    // Process events in order to get current follow state
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
    for (const event of sorted) {
      // Support both old feed_key and new swarm_id for backward compatibility
      const id = event.swarm_id || event.feed_key
      if (!id || !HEX64_RE.test(id)) continue
      if (event.type === 'follow') {
        following.add(id.toLowerCase())
      } else if (event.type === 'unfollow') {
        following.delete(id.toLowerCase())
      }
    }

    // Re-establish P2P connections for each followed user (in parallel)
    console.log('[Feed] Restoring', following.size, 'follows in parallel')
    const followPromises = Array.from(following).map(async (swarmId) => {
      try {
        await this.follow(swarmId, { skipFlush: true })
        console.log('[Feed] Joined topic:', swarmId.slice(0, 16) + '...')
      } catch (err) {
        console.error('Error restoring follow:', swarmId.slice(0, 16), err.message)
      }
    })

    await Promise.all(followPromises)

    // Single flush after all topics joined
    if (following.size > 0) {
      console.log('[Feed] Flushing swarm for', following.size, 'follows')
      await this.swarm.flush()
      console.log('[Feed] All follows restored')
    }
  }

  /**
   * Append an event to our feed
   */
  async append(event) {
    const entry = {
      ...event,
      pubkey: this.identity.pubkeyHex,
      timestamp: Date.now()
    }

    // Sign the event
    const message = JSON.stringify(entry)
    const signature = this.identity.sign(message)
    entry.signature = b4a.toString(signature, 'hex')

    await this.core.append(Buffer.from(JSON.stringify(entry)))
    return entry
  }

  /**
   * Read events from our feed
   */
  async read(start = 0, end = this.core.length) {
    const events = []
    for (let i = start; i < end; i++) {
      const data = await this.core.get(i)
      if (data) {
        events.push(JSON.parse(data.toString()))
      }
    }
    return events
  }

  /**
   * Get feed length
   */
  get length() {
    return this.core.length
  }

  /**
   * Get our Swarm ID (public key for sharing)
   */
  get swarmId() {
    return b4a.toString(this.core.key, 'hex')
  }

  /**
   * Get peer count
   */
  get peerCount() {
    // Only count connections for our topics (our feed + feeds we follow)
    return this.relevantConns.size
  }

  /**
   * Follow another user by their Swarm ID
   * @param {string} swarmIdHex - The swarm ID to follow
   * @param {object} options - Options
   * @param {boolean} options.skipFlush - Skip swarm.flush() for batch operations
   */
  async follow(swarmIdHex, { skipFlush = false, infrastructure = false } = {}) {
    if (typeof swarmIdHex !== 'string' || !/^[a-f0-9]{64}$/i.test(swarmIdHex)) {
      throw new Error('Invalid swarm ID (must be 64-char hex)')
    }
    swarmIdHex = swarmIdHex.toLowerCase()
    const swarmIdKey = b4a.from(swarmIdHex, 'hex')

    // Get or create a core for this peer
    const peerCore = this.store.get({ key: swarmIdKey })
    await peerCore.ready()

    // Listen for new data from this peer
    peerCore.on('append', () => {
      if (this.onDataUpdate) this.onDataUpdate()
    })

    // Add to peers BEFORE joining swarm so connection handler can detect we follow them
    this.peers.set(swarmIdHex, peerCore)

    // Compute the discovery key BEFORE swarm.join. If this is an infrastructure
    // follow (e.g. the sync server), register it in infrastructureTopics first
    // so the on('connection') handler sets conn._isInfrastructure immediately
    // instead of racing with a post-hoc marker call.
    const peerDiscoveryKeyHex = b4a.toString(peerCore.discoveryKey, 'hex')
    this.myTopics.add(peerDiscoveryKeyHex)
    if (infrastructure) {
      this.infrastructureTopics.add(peerDiscoveryKeyHex)
    }
    this.swarm.join(peerCore.discoveryKey)

    // Only flush if not in batch mode
    if (!skipFlush) {
      await this.swarm.flush()
    }

    return peerCore
  }

  /**
   * Unfollow a user - remove from peers and leave swarm topic
   */
  async unfollow(swarmIdHex) {
    if (typeof swarmIdHex !== 'string' || !/^[a-f0-9]{64}$/i.test(swarmIdHex)) return
    swarmIdHex = swarmIdHex.toLowerCase()
    const peerCore = this.peers.get(swarmIdHex)
    if (peerCore) {
      // Remove from our topics and leave the swarm
      const peerDiscoveryKeyHex = b4a.toString(peerCore.discoveryKey, 'hex')
      this.myTopics.delete(peerDiscoveryKeyHex)
      await this.swarm.leave(peerCore.discoveryKey)
      this.peers.delete(swarmIdHex)
    }
  }

  /**
   * Read a peer's feed
   */
  async readPeer(swarmIdHex, start = 0, end) {
    const peerCore = this.peers.get(swarmIdHex)
    if (!peerCore) throw new Error('Not following this peer')

    await updateWithTimeout(peerCore) // Sync latest (with timeout)
    const length = end ?? peerCore.length

    const events = []
    for (let i = start; i < length; i++) {
      const data = await getWithTimeout(peerCore, i)
      if (data) {
        const event = JSON.parse(data.toString())
        // Verify signature before including event
        if (verifyEventSignature(event)) {
          events.push(event)
        } else {
          console.warn(`Invalid signature for event from peer ${swarmIdHex.slice(0, 16)}... at index ${i}`)
        }
      }
    }
    return events
  }

  /**
   * Get profiles from all followed peers
   * Also collects supporter_listing events for P2P directory sync
   */
  async getPeerProfiles() {
    const profiles = {}
    const swarmIdToPubkey = {}
    const pubkeyToSwarmId = {}
    const supporterListings = {} // pubkey -> latest supporter_listing event

    // Process all peers in parallel
    const peerResults = await Promise.all(
      Array.from(this.peers.entries()).map(async ([swarmId, core]) => {
        try {
          await updateWithTimeout(core)
          const peerProfiles = []
          const peerListings = []
          let pubkey = null

          for (let i = 0; i < core.length; i++) {
            const data = await getWithTimeout(core, i)
            if (data) {
              const event = JSON.parse(data.toString())
              if (!verifyEventSignature(event)) {
                continue
              }
              if (event.pubkey && !pubkey) {
                pubkey = event.pubkey
              }
              if (event.type === 'profile') {
                peerProfiles.push(event)
              }
              if (event.type === 'supporter_listing' && event.tx_proof) {
                peerListings.push({ ...event, swarmId })
              }
            }
          }
          return { swarmId, pubkey, profiles: peerProfiles, listings: peerListings }
        } catch (err) {
          console.error(`Error reading peer ${swarmId.slice(0, 16)}:`, err.message)
          return null
        }
      })
    )

    // Merge results
    for (const result of peerResults) {
      if (!result) continue
      const { swarmId, pubkey, profiles: peerProfiles, listings: peerListings } = result
      if (pubkey) {
        swarmIdToPubkey[swarmId] = pubkey
        pubkeyToSwarmId[pubkey] = swarmId
      }
      for (const profile of peerProfiles) {
        if (!profiles[profile.pubkey] || profile.timestamp > profiles[profile.pubkey].timestamp) {
          profiles[profile.pubkey] = profile
        }
        // Populate verified bindings from self-attested profile events
        this.ingestSignedProfile(profile)
      }
      for (const listing of peerListings) {
        if (!supporterListings[listing.pubkey] || listing.timestamp > supporterListings[listing.pubkey].timestamp) {
          supporterListings[listing.pubkey] = listing
        }
      }
    }

    return { profiles, swarmIdToPubkey, pubkeyToSwarmId, supporterListings }
  }

  /**
   * Get timeline - merged events from followed feeds
   */
  async getTimeline(limit = 500) {
    // Get our own events and peer events in parallel
    const [ours, ...peerResults] = await Promise.all([
      this.read(),
      ...Array.from(this.peers.entries()).map(async ([key, core]) => {
        try {
          await updateWithTimeout(core)
          const events = []
          for (let i = 0; i < core.length; i++) {
            const data = await getWithTimeout(core, i)
            if (data) {
              const event = JSON.parse(data.toString())
              if (verifyEventSignature(event)) {
                events.push(event)
              }
            }
          }
          return events
        } catch (err) {
          console.error(`Error reading peer ${key.slice(0, 16)}:`, err.message)
          return []
        }
      })
    ])

    // Merge all events
    const allEvents = [...ours]
    for (const peerEvents of peerResults) {
      allEvents.push(...peerEvents)
    }

    // Sort by timestamp, newest first
    allEvents.sort((a, b) => b.timestamp - a.timestamp)

    return allEvents.slice(0, limit)
  }

  /**
   * Get list of followed Swarm IDs
   */
  getFollowing() {
    return Array.from(this.peers.keys())
  }

  /**
   * Get tagged posts for FoF responses
   * @param {number} limit - Max posts to return
   * @returns {Promise<Array>} Posts with tags
   */
  async getTaggedPosts(limit = 20) {
    // Get recent posts that have tags
    const allEvents = await this.getTimeline(limit * 5) // Fetch more to filter
    const posts = allEvents.filter(p => p.type === 'post' && p.tags && p.tags.length > 0)
    return posts.slice(0, limit)
  }

  /**
   * Get list of followers (users who follow us)
   */
  getFollowers() {
    return Array.from(this.followers)
  }

  /**
   * Check if we have a mutual follow with a user
   * @param {string} swarmIdHex - The user's swarm ID
   * @returns {boolean} True if both parties follow each other
   */
  isMutualFollow(swarmIdHex) {
    const weFollowThem = this.peers.has(swarmIdHex)
    const theyFollowUs = this.followers.has(swarmIdHex)
    return weFollowThem && theyFollowUs
  }

  /**
   * Check if we can DM a user (mutual follow by pubkey lookup)
   * @param {string} pubkeyHex - The user's Ed25519 public key
   * @param {Object} pubkeyToSwarmId - Mapping from pubkey to swarmId
   * @returns {boolean} True if mutual follow exists
   */
  canDM(pubkeyHex, pubkeyToSwarmId) {
    // Prefer caller-supplied mapping (computed at login), fall back to our
    // verified bindings so mappings learned via FoF after login still count.
    const swarmId = pubkeyToSwarmId?.[pubkeyHex] || this.getVerifiedSwarmId(pubkeyHex)
    if (!swarmId) return false
    return this.isMutualFollow(swarmId)
  }

  /**
   * Get the follow relationship status with a user
   * @param {string} swarmIdHex - The user's swarm ID
   * @returns {'mutual' | 'following' | 'follower' | 'none'}
   */
  getFollowStatus(swarmIdHex) {
    const weFollowThem = this.peers.has(swarmIdHex)
    const theyFollowUs = this.followers.has(swarmIdHex)

    if (weFollowThem && theyFollowUs) return 'mutual'
    if (weFollowThem) return 'following'
    if (theyFollowUs) return 'follower'
    return 'none'
  }

  /**
   * Get reply metadata for a post from a peer's feed
   * This tells us who has replied to their post (for thread visibility indicators)
   * @param {string} swarmIdHex - The peer's swarm ID
   * @param {number} postTimestamp - The post's timestamp
   * @returns {Promise<Array>} Array of replier info
   */
  async getReplyMetadataForPost(swarmIdHex, postTimestamp) {
    const peerCore = this.peers.get(swarmIdHex)
    if (!peerCore) return []

    try {
      await peerCore.update()
      const metadata = []

      for (let i = 0; i < peerCore.length; i++) {
        const data = await getWithTimeout(peerCore, i)
        if (data) {
          const event = JSON.parse(data.toString())
          if (event.type === 'reply_metadata' && event.post_timestamp === postTimestamp) {
            if (verifyEventSignature(event)) {
              metadata.push(event.replier)
            }
          }
        }
      }

      return metadata
    } catch (err) {
      console.warn(`[Feed] Error getting reply metadata from ${swarmIdHex.slice(0, 8)}:`, err.message)
      return []
    }
  }

  /**
   * Get all reply metadata from our own feed
   * @returns {Promise<Map>} Map of postTimestamp -> Array of replier info
   */
  async getOwnReplyMetadata() {
    const events = await this.read()
    const metadataByPost = new Map()

    for (const event of events) {
      if (event.type === 'reply_metadata') {
        const key = event.post_timestamp
        if (!metadataByPost.has(key)) {
          metadataByPost.set(key, [])
        }
        metadataByPost.get(key).push(event.replier)
      }
    }

    return metadataByPost
  }

  /**
   * Check if we follow a user by their swarm ID
   * @param {string} swarmIdHex - The user's swarm ID
   * @returns {boolean}
   */
  isFollowing(swarmIdHex) {
    return this.peers.has(swarmIdHex)
  }

  /**
   * Scan peer feeds for follow events targeting our swarm ID
   * Updates the followers Set and persists to disk
   */
  async updateFollowers() {
    const mySwarmId = this.swarmId

    // Check all peers in parallel
    const results = await Promise.all(
      Array.from(this.peers.entries()).map(async ([swarmId, core]) => {
        try {
          await updateWithTimeout(core)
          let followsUs = false

          for (let i = 0; i < core.length; i++) {
            const data = await getWithTimeout(core, i)
            if (data) {
              const event = JSON.parse(data.toString())
              if (!verifyEventSignature(event)) continue

              const targetId = event.swarm_id || event.feed_key
              if (targetId === mySwarmId) {
                if (event.type === 'follow') {
                  followsUs = true
                } else if (event.type === 'unfollow') {
                  followsUs = false
                }
              }
            }
          }
          return followsUs ? swarmId : null
        } catch (err) {
          console.warn(`[Feed] Error checking if ${swarmId.slice(0, 8)}... follows us:`, err.message)
          return null
        }
      })
    )

    // Merge scan results with existing followers
    // Only update status for peers we actually scanned (in this.peers)
    // This preserves followers detected via announcements who we don't follow back
    const scannedPeers = new Set(this.peers.keys())

    for (const result of results) {
      if (result !== null) {
        // This peer follows us - add them
        this.followers.add(result)
      }
    }

    // Remove unfollowers only from peers we scanned
    // (If we scanned them and they're not in results, they unfollowed)
    for (const swarmId of scannedPeers) {
      if (!results.includes(swarmId)) {
        this.followers.delete(swarmId)
      }
    }

    console.log(`[Feed] Updated followers: ${this.followers.size} users follow us`)

    // Persist to disk
    await this._saveFollowers()
  }

  /**
   * Save followers to disk for persistence across restarts
   */
  async _saveFollowers() {
    const followersPath = path.join(this.dataDir, `followers-${this.identity.pubkeyHex}.json`)
    try {
      const data = { followers: Array.from(this.followers) }
      fs.writeFileSync(followersPath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.error('[Feed] Error saving followers:', err.message)
    }
  }

  /**
   * Load followers from disk
   */
  async _loadFollowers() {
    const followersPath = path.join(this.dataDir, `followers-${this.identity.pubkeyHex}.json`)
    try {
      if (fs.existsSync(followersPath)) {
        const data = JSON.parse(fs.readFileSync(followersPath, 'utf8'))
        this.followers = new Set(data.followers || [])
        console.log(`[Feed] Loaded ${this.followers.size} followers from disk`)
      }
    } catch (err) {
      console.error('[Feed] Error loading followers:', err.message)
    }
  }

  async close() {
    // Leave swarm topics for all followed peers
    for (const [swarmId, peerCore] of this.peers) {
      try {
        if (peerCore.discoveryKey) {
          await this.swarm.leave(peerCore.discoveryKey)
        }
      } catch (err) {
        console.warn(`Error leaving peer topic ${swarmId.slice(0, 8)}:`, err.message)
      }
    }

    // Leave our own topic
    if (this.core?.discoveryKey) {
      try {
        await this.swarm.leave(this.core.discoveryKey)
      } catch (err) {
        console.warn('Error leaving own topic:', err.message)
      }
    }

    // Clear peer, topic, and connection references
    this.peers.clear()
    this.myTopics.clear()
    this.relevantConns.clear()

    // Remove data update callback to prevent stale calls
    this.onDataUpdate = null
    this.onPeerUpdate = null

    // Close ReplyNotify protocol handler
    if (this.replyNotify) {
      try {
        await this.replyNotify.close()
      } catch (err) {
        console.warn('Error closing ReplyNotify:', err.message)
      }
      this.replyNotify = null
    }

    // Destroy swarm (closes all connections)
    if (this.swarm) {
      try {
        await this.swarm.destroy()
      } catch (err) {
        console.warn('Error destroying swarm:', err.message)
      }
      this.swarm = null
    }

    // Close store (this closes all cores)
    if (this.store) {
      try {
        await this.store.close()
      } catch (err) {
        console.warn('Error closing store:', err.message)
      }
      this.store = null
    }

    this.core = null
  }
}
