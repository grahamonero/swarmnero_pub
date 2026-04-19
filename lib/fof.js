/**
 * FoF (Friend-of-Friend) Protocol Handler
 *
 * Enables discovery and caching of content from friends-of-friends
 * using Protomux for protocol negotiation over existing connections.
 *
 * Flow:
 * 1. On peer connection (for followed users), set up Protomux channel
 * 2. Send fof_request asking for their following list + recent tagged posts
 * 3. Receive fof_response with their following list and 20 tagged posts per follow
 * 4. Add posts to fofCache with viaSwarmId
 * 5. Index posts in tagIndex
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { verifyEventSignature } from './feed.js'

// Protocol name for FoF exchange
const FOF_PROTOCOL = 'swarmnero-fof-v1'

// Default limits
const DEFAULT_LIMIT = 1000
const POSTS_PER_FOLLOW = 20

// Security limits
const MAX_MESSAGE_SIZE = 5_000_000    // 5MB max payload
const MAX_POSTS = 100                  // Max posts per response
const MAX_POST_CONTENT = 50_000        // 50KB max per post content
const MAX_FOLLOWING = 500              // Max following list size
const MAX_PROFILES = 200               // Max profiles per response
const MAX_PROFILE_NAME = 100
const MAX_PROFILE_BIO = 500
const MAX_PROFILE_AVATAR = 64 * 1024
const MAX_PROFILE_WEBSITE = 2048
const RATE_LIMIT_MS = 10_000           // 10 seconds between requests per peer

function _capStr(s, max) {
  if (typeof s !== 'string') return null
  return s.length > max ? s.slice(0, max) : s
}

export class FoF {
  /**
   * @param {Object} options
   * @param {Object} options.feed - Feed instance for swarm access
   * @param {Object} options.fofCache - Cache for friend-of-friend posts
   * @param {Object} options.tagIndex - Index for tagged posts
   * @param {string} options.dataDir - Data directory
   */
  constructor({ feed, fofCache, tagIndex, dataDir }) {
    this.feed = feed
    this.fofCache = fofCache
    this.tagIndex = tagIndex
    this.dataDir = dataDir
    this._connectionHandler = null
    this._setupConnections = new Set() // Track connections with FoF channel
    this._requestTimes = new Map() // peerId -> lastRequestTime (rate limiting)
  }

  /**
   * Initialize the FoF handler
   * Sets up connection handler on feed's swarm
   */
  async init() {
    if (!this.feed || !this.feed.swarm) {
      throw new Error('Feed with swarm required for FoF')
    }

    // Set up connection handler for FoF
    this._connectionHandler = (conn, info) => {
      this._handleConnection(conn, info)
    }
    this.feed.swarm.on('connection', this._connectionHandler)

    // Set up Protomux on all existing connections
    if (this.feed.swarm.connections) {
      for (const conn of this.feed.swarm.connections) {
        this._handleConnection(conn)
      }
    }

    // Periodically retry setting up FoF on all connections
    // This handles cases where Protomux handshake failed due to timing
    this._retryInterval = setInterval(() => {
      this._retryAllConnections()
    }, 10000) // Every 10 seconds

    console.log('[FoF] Initialized')
    return this
  }

  /**
   * Retry setting up FoF channels on all connections that don't have one
   */
  _retryAllConnections() {
    if (!this.feed?.swarm?.connections) return

    let setupCount = 0
    for (const conn of this.feed.swarm.connections) {
      if (conn.destroyed) continue
      if (conn._isInfrastructure) continue

      // If no channel exists, try to set up or create one
      if (!conn._fofChannel || conn._fofChannel.closed) {
        if (conn._fofPaired) {
          // Pair listener exists, just try to create channel
          console.log('[FoF] Retrying channel creation on paired connection')
          const mux = Protomux.from(conn)
          if (!mux.destroyed) {
            this._createChannel(mux, conn)
            setupCount++
          }
        } else {
          // No pair listener yet, do full setup
          console.log('[FoF] Setting up new connection')
          this._setupProtomux(conn)
          setupCount++
        }
      }
    }

    if (setupCount > 0) {
      console.log(`[FoF] Retried setup on ${setupCount} connection(s)`)
    }
  }

  /**
   * Clean up handlers
   */
  async close() {
    // Stop retry interval
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }

    // Remove connection handler
    if (this._connectionHandler && this.feed?.swarm) {
      this.feed.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Clear channel references from connections
    for (const conn of this._setupConnections) {
      try {
        if (conn._fofChannel) {
          conn._fofChannel = null
          conn._fofMessage = null
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    }
    this._setupConnections.clear()

    console.log('[FoF] Closed')
  }

  /**
   * Request FoF data from a peer
   * @param {Object} conn - Connection to request from
   * @param {number} since - Timestamp to get posts since (default: 24h ago)
   * @param {number} limit - Max items to request
   * @returns {Promise<boolean>} True if request was sent
   */
  async requestFoF(conn, since = Date.now() - 24 * 60 * 60 * 1000, limit = DEFAULT_LIMIT) {
    // Ensure connection has FoF channel set up
    if (!conn._fofMessage) {
      console.log('[FoF] Connection not ready, setting up channel first')
      this._setupProtomux(conn)

      // Wait a bit for channel to open
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (!conn._fofMessage) {
      console.warn('[FoF] Cannot send request - no message channel')
      return false
    }

    // Note: senderSwarmId/isFollowing intentionally omitted — follower discovery
    // is handled by updateFollowers() which scans signed follow events on peer
    // feeds. Trusting an unauthenticated FoF claim allowed any peer to inject
    // themselves into our follower list.
    const request = {
      type: 'fof_request',
      since,
      limit
    }

    try {
      conn._fofMessage.send(b4a.from(JSON.stringify(request)))
      console.log('[FoF] Sent fof_request')
      return true
    } catch (err) {
      console.error('[FoF] Error sending request:', err.message)
      return false
    }
  }

  /**
   * Handle new connection - set up Protomux channel
   * @param {Object} conn - Connection object
   * @param {Object} info - Connection info
   */
  _handleConnection(conn, info) {
    // Skip infrastructure connections (e.g. sync server) - they don't speak FoF
    if (conn._isInfrastructure) return

    // Set up FoF for all connections - we can't reliably determine
    // if a connection is for a followed peer since topics may not match
    // The protocol handshake will fail gracefully if peer doesn't support FoF
    console.log('[FoF] New connection, setting up channel')

    // Track connection lifecycle
    conn.once('close', () => {
      console.log('[FoF] Underlying connection closed')
    })
    conn.once('error', (err) => {
      console.log('[FoF] Connection error:', err.message)
    })

    this._setupProtomux(conn)
  }

  /**
   * Set up Protomux channel on a connection
   * @param {Object} conn - Connection object
   */
  _setupProtomux(conn) {
    // Skip infrastructure connections (e.g. sync server)
    if (conn._isInfrastructure) return

    // Skip if already set up and channel is still open
    if (conn._fofChannel && !conn._fofChannel.closed) {
      return
    }

    // Skip if pair listener already set up
    if (conn._fofPaired) {
      return
    }

    console.log('[FoF] Setting up Protomux channel')

    try {
      // Create Protomux instance for this connection
      const mux = Protomux.from(conn)

      // Skip if mux is destroyed
      if (mux.destroyed) {
        console.log('[FoF] Mux already destroyed, skipping')
        return
      }

      // Mark that we've set up the pair listener for this connection
      conn._fofPaired = true

      // 1. Listen for the remote peer trying to open this protocol
      mux.pair({ protocol: FOF_PROTOCOL }, () => {
        console.log('[FoF] Remote peer requested FoF channel, creating response channel')
        this._createChannel(mux, conn)
      })

      // 2. Also initiate the channel ourselves
      this._createChannel(mux, conn)

    } catch (err) {
      console.error('[FoF] Error setting up Protomux:', err.message)
    }
  }

  /**
   * Create and open a FoF channel on a mux instance
   * @param {Object} mux - Protomux instance
   * @param {Object} conn - Connection object
   */
  _createChannel(mux, conn) {
    // Skip if channel already exists and is open
    if (conn._fofChannel && !conn._fofChannel.closed) {
      console.log('[FoF] Channel already exists and is open')
      return
    }

    const channel = mux.createChannel({
      protocol: FOF_PROTOCOL,
      unique: true,
      onopen: () => {
        console.log('[FoF] Handshake complete! Channel opened with peer')
        // Auto-request FoF data when channel opens
        setTimeout(() => {
          if (conn._fofMessage) {
            this.requestFoF(conn).catch(err => {
              console.warn('[FoF] Auto-request failed:', err.message)
            })
          }
        }, 500)
      },
      onclose: () => {
        console.log('[FoF] Protocol channel closed')
        conn._fofChannel = null
        conn._fofMessage = null
        this._setupConnections.delete(conn)
      },
      ondestroy: () => {
        console.log('[FoF] Protocol channel destroyed')
      }
    })

    if (!channel) {
      console.log('[FoF] Failed to create channel (null returned)')
      return
    }

    // Handle incoming messages with raw buffer encoding for size checking
    const message = channel.addMessage({
      encoding: c.buffer,
      onmessage: (buf) => {
        // Check buffer size BEFORE JSON parsing (DoS prevention)
        if (buf.length > MAX_MESSAGE_SIZE) {
          console.warn(`[FoF] Rejected oversized message: ${buf.length} bytes (max ${MAX_MESSAGE_SIZE})`)
          return
        }

        let msg
        try {
          msg = JSON.parse(buf.toString())
        } catch (err) {
          console.warn('[FoF] Invalid JSON in message:', err.message)
          return
        }

        this._handleMessage(msg, conn)
      }
    })

    // Store references on the connection
    conn._fofChannel = channel
    conn._fofMessage = message
    this._setupConnections.add(conn)

    // Open the channel
    channel.open()
    console.log('[FoF] Channel opened locally, waiting for remote handshake...')
  }

  /**
   * Handle incoming FoF protocol messages
   * @param {Object} msg - Message object
   * @param {Object} conn - Connection object
   */
  async _handleMessage(msg, conn) {
    console.log('[FoF] Received message:', msg.type)

    if (msg.type === 'fof_request') {
      await this._handleRequest(msg, conn)
    } else if (msg.type === 'fof_response') {
      await this._handleResponse(msg, conn)
    } else if (msg.type === 'profile_request') {
      this._handleProfileRequest(msg, conn)
    } else if (msg.type === 'profile_response') {
      this._handleProfileResponse(msg)
    }
  }

  /**
   * Handle incoming fof_request - respond with our following list and tagged posts
   * @param {Object} msg - Request message { type, since, limit }
   * @param {Object} conn - Connection object
   */
  async _handleRequest(msg, conn) {
    // Rate limiting: 1 request per RATE_LIMIT_MS per peer
    const peerId = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : 'unknown'
    const now = Date.now()
    const lastRequest = this._requestTimes.get(peerId)

    if (lastRequest && (now - lastRequest) < RATE_LIMIT_MS) {
      console.warn(`[FoF] Rate limited peer ${peerId.slice(0, 8)} (${now - lastRequest}ms since last request)`)
      return
    }
    this._requestTimes.set(peerId, now)

    let { since = 0, limit = DEFAULT_LIMIT } = msg

    // Validate since: must be a finite non-negative number not in the future.
    // Negative or NaN values would otherwise cause the responder to scan
    // the entire timeline (bandwidth amplification).
    const nowTs = Date.now()
    if (typeof since !== 'number' || !Number.isFinite(since) || since < 0 || since > nowTs) {
      since = 0
    }
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      limit = DEFAULT_LIMIT
    }
    limit = Math.min(limit, DEFAULT_LIMIT)

    console.log('[FoF] Handling fof_request, since:', new Date(since).toISOString())

    try {
      // Get our following list
      const following = this.feed.getFollowing()

      // Collect tagged posts from our timeline
      const posts = []
      const profiles = {} // pubkey -> { name, swarmId }
      const allEvents = await this.feed.getTimeline(limit)

      for (const event of allEvents) {
        // Only include posts with tags and after 'since' timestamp
        if (event.type === 'post' && event.tags && event.tags.length > 0 && event.timestamp >= since) {
          posts.push({
            pubkey: event.pubkey,
            timestamp: event.timestamp,
            content: event.content,
            tags: event.tags,
            media: event.media,
            signature: event.signature
          })

          // Ship the full signed profile event for this pubkey if we have
          // one. Receiver verifies the signature and extracts the
          // self-attested swarmId -> pubkey binding, which cannot be spoofed
          // by us because we don't hold the author's private key.
          if (!profiles[event.pubkey] && event.pubkey && Object.keys(profiles).length < MAX_PROFILES) {
            const signedProfile = this.feed.peerProfiles?.[event.pubkey]
            if (signedProfile && signedProfile.signature && signedProfile.pubkey === event.pubkey && signedProfile.type === 'profile') {
              profiles[event.pubkey] = signedProfile
            }
          }

          // Limit posts per response
          if (posts.length >= POSTS_PER_FOLLOW * following.length) {
            break
          }
        }
      }

      // Also include our own swarm ID and name so receiver knows who sent this
      const mySwarmId = this.feed.swarmId
      const myName = this.feed.myProfile?.name

      // Send response
      const response = {
        type: 'fof_response',
        following,
        posts,
        profiles,
        senderSwarmId: mySwarmId,
        senderName: myName
      }

      if (conn._fofMessage) {
        // Send as buffer (matching our buffer encoding)
        conn._fofMessage.send(b4a.from(JSON.stringify(response)))
        console.log(`[FoF] Sent fof_response with ${following.length} following, ${posts.length} posts, ${Object.keys(profiles).length} profiles`)
      }
    } catch (err) {
      console.error('[FoF] Error handling request:', err.message)
    }
  }

  /**
   * Handle incoming fof_response - cache posts and index tags
   * @param {Object} msg - Response message { type, following, posts, profiles, senderSwarmId }
   * @param {Object} conn - Connection object
   */
  async _handleResponse(msg, conn) {
    let { following = [], posts = [], profiles = {}, senderSwarmId, senderName } = msg

    // Enforce size limits (truncate, don't reject)
    if (following.length > MAX_FOLLOWING) {
      console.warn(`[FoF] Truncating following list from ${following.length} to ${MAX_FOLLOWING}`)
      following = following.slice(0, MAX_FOLLOWING)
    }
    if (posts.length > MAX_POSTS) {
      console.warn(`[FoF] Truncating posts from ${posts.length} to ${MAX_POSTS}`)
      posts = posts.slice(0, MAX_POSTS)
    }

    // Filter out oversized posts
    const originalPostCount = posts.length
    posts = posts.filter(p => {
      if (p.content && p.content.length > MAX_POST_CONTENT) {
        console.warn(`[FoF] Rejected oversized post content: ${p.content.length} bytes`)
        return false
      }
      return true
    })
    if (posts.length !== originalPostCount) {
      console.warn(`[FoF] Filtered ${originalPostCount - posts.length} oversized posts`)
    }

    console.log(`[FoF] Handling fof_response: ${following.length} following, ${posts.length} posts, ${Object.keys(profiles).length} profiles, from ${senderName || 'unknown'}`)

    // Use senderSwarmId from message, fallback to connection key
    let viaSwarmId = senderSwarmId
    if (!viaSwarmId && conn.remotePublicKey) {
      viaSwarmId = b4a.toString(conn.remotePublicKey, 'hex')
    }

    // Get the via name (who sent us this data)
    const viaName = senderName || null

    // Ingest signed profile events, cap entries and field sizes. Only
    // profile events whose signatures verify against the stated pubkey are
    // admitted. The self-attested swarmId in each signed event yields a
    // cryptographic pubkey -> swarmId binding the receiver can trust.
    if (!this.fofProfiles) {
      this.fofProfiles = {}
    }
    const profileEntries = Object.entries(profiles).slice(0, MAX_PROFILES)
    let verifiedBindings = 0
    for (const [pubkey, profileEvent] of profileEntries) {
      if (!/^[a-f0-9]{64}$/i.test(pubkey)) continue
      // Reject anything that isn't a well-formed signed profile event
      if (!profileEvent || typeof profileEvent !== 'object') continue
      if (profileEvent.type !== 'profile' || profileEvent.pubkey !== pubkey) continue
      if (!profileEvent.signature) continue
      // Verify signature using the feed helper (also populates verifiedBindings
      // when a self-attested swarmId is present and matches pubkey format)
      const bindingAdded = this.feed?.ingestSignedProfile(profileEvent)
      if (bindingAdded) verifiedBindings++
      // Cache display fields (size-capped) for UI rendering
      this.fofProfiles[pubkey] = {
        name: _capStr(profileEvent.name, MAX_PROFILE_NAME),
        bio: _capStr(profileEvent.bio, MAX_PROFILE_BIO),
        avatar: _capStr(profileEvent.avatar, MAX_PROFILE_AVATAR),
        website: _capStr(profileEvent.website, MAX_PROFILE_WEBSITE),
        // Only expose the swarmId if the binding was verified
        swarmId: bindingAdded ? this.feed.getVerifiedSwarmId(pubkey) : null
      }
    }
    if (verifiedBindings > 0) {
      console.log(`[FoF] Verified ${verifiedBindings} pubkey->swarmId bindings from response`)
    }

    // Process received posts with signature verification
    let addedCount = 0
    let rejectedCount = 0
    for (const post of posts) {
      try {
        // SECURITY: Verify signature before accepting post
        // This prevents malicious peers from injecting fake posts
        if (!post.pubkey || !post.signature) {
          console.warn('[FoF] Rejected post: missing pubkey or signature')
          rejectedCount++
          continue
        }

        // Validate pubkey format (32 bytes = 64 hex chars)
        if (!/^[0-9a-fA-F]{64}$/.test(post.pubkey)) {
          console.warn('[FoF] Rejected post: invalid pubkey format')
          rejectedCount++
          continue
        }

        // Validate signature format (64 bytes = 128 hex chars)
        if (!/^[0-9a-fA-F]{128}$/.test(post.signature)) {
          console.warn('[FoF] Rejected post: invalid signature format')
          rejectedCount++
          continue
        }

        // Stateless signature verification
        if (!verifyEventSignature(post)) {
          console.warn(`[FoF] Rejected post: signature verification failed for ${post.pubkey.slice(0, 8)}`)
          rejectedCount++
          continue
        }

        // Get profile info for this post's author (display only)
        const authorProfile = this.fofProfiles[post.pubkey]
        // Only use the swarmId if we have a cryptographically verified
        // pubkey -> swarmId binding from a signed profile event.
        const verifiedSwarmId = this.feed?.getVerifiedSwarmId?.(post.pubkey) || null

        // Add to FoF cache with verified binding (or null if unverified).
        if (this.fofCache && this.fofCache.add) {
          const cached = this.fofCache.add({
            ...post,
            authorName: authorProfile?.name,
            authorSwarmId: verifiedSwarmId,
            authorBio: authorProfile?.bio,
            authorAvatar: authorProfile?.avatar,
            authorWebsite: authorProfile?.website,
            viaName
          }, viaSwarmId)
          if (cached) addedCount++
        }

        // Index by tags using TagIndex class
        if (this.tagIndex && this.tagIndex.indexPost && post.tags) {
          this.tagIndex.indexPost({
            pubkey: post.pubkey,
            timestamp: post.timestamp,
            tags: post.tags,
            content: post.content,
            authorSwarmId: verifiedSwarmId,
            source: 'fof'
          })
        }
      } catch (err) {
        console.warn('[FoF] Error processing post:', err.message)
        rejectedCount++
      }
    }

    if (rejectedCount > 0) {
      console.warn(`[FoF] Rejected ${rejectedCount} posts due to validation/signature failures`)
    }

    console.log(`[FoF] Added ${addedCount} posts to cache`)

    // Store the following list for potential future use
    if (following.length > 0 && viaSwarmId) {
      console.log(`[FoF] Received ${following.length} following from ${viaSwarmId.slice(0, 16)}...`)
    }
  }

  /**
   * Request FoF data from all connected followed peers
   * @param {number} since - Timestamp to get posts since
   * @returns {Promise<number>} Number of requests sent
   */
  async requestFromAllPeers(since = Date.now() - 24 * 60 * 60 * 1000) {
    let sentCount = 0

    for (const conn of this._setupConnections) {
      try {
        const sent = await this.requestFoF(conn, since)
        if (sent) sentCount++
      } catch (err) {
        console.warn('[FoF] Error requesting from peer:', err.message)
      }
    }

    console.log(`[FoF] Sent ${sentCount} fof_request(s)`)
    return sentCount
  }

  /**
   * Get posts from cache by tag
   * @param {string} tag - Tag to search for
   * @returns {Array} Posts with this tag
   */
  getPostsByTag(tag) {
    if (!this.fofCache || !this.fofCache.getByTag) return []
    return this.fofCache.getByTag(tag)
  }

  /**
   * Get all cached FoF posts
   * @param {number} limit - Max posts to return
   * @returns {Array} Cached posts sorted by timestamp
   */
  getCachedPosts(limit = 100) {
    if (!this.fofCache || !this.fofCache.getAll) return []
    const posts = this.fofCache.getAll()
    return posts.slice(0, limit)
  }

  /**
   * Clear the FoF cache
   */
  clearCache() {
    if (this.fofCache) {
      this.fofCache.clear()
    }
    if (this.tagIndex) {
      this.tagIndex.clear()
    }
    this.fofProfiles = {}
    console.log('[FoF] Cache cleared')
  }

  /**
   * Get a FoF profile by pubkey
   * @param {string} pubkey - The pubkey to look up
   * @returns {Object|null} Profile data or null
   */
  getFoFProfile(pubkey) {
    return this.fofProfiles?.[pubkey] || null
  }

  /**
   * Get all FoF profiles
   * @returns {Object} Map of pubkey -> profile
   */
  getAllFoFProfiles() {
    return this.fofProfiles || {}
  }

  /**
   * Request profile data for specific swarmIds from connected peers
   * @param {Array<string>} swarmIds - SwarmIds to look up
   * @returns {Promise<Object>} Map of swarmId -> { name, bio, avatar, website, pubkey }
   */
  async requestProfiles(swarmIds) {
    if (!swarmIds || swarmIds.length === 0) return {}

    return new Promise((resolve) => {
      // Store callback for when response arrives
      this._profileRequestCallback = resolve

      // Timeout after 5 seconds
      this._profileRequestTimeout = setTimeout(() => {
        this._profileRequestCallback = null
        resolve({})
      }, 5000)

      // Send request on all active FoF connections
      const request = {
        type: 'profile_request',
        swarmIds: swarmIds.slice(0, 50) // Limit to 50
      }

      let sent = false
      for (const conn of this._setupConnections) {
        if (conn._fofMessage && !conn.destroyed) {
          try {
            conn._fofMessage.send(b4a.from(JSON.stringify(request)))
            sent = true
          } catch (err) {
            // skip failed connections
          }
        }
      }

      if (!sent) {
        clearTimeout(this._profileRequestTimeout)
        this._profileRequestCallback = null
        resolve({})
      }
    })
  }

  /**
   * Handle incoming profile request — respond with profile data for requested swarmIds
   */
  _handleProfileRequest(msg, conn) {
    const { swarmIds } = msg
    if (!Array.isArray(swarmIds) || swarmIds.length === 0) return

    const profiles = {}
    for (const swarmId of swarmIds.slice(0, 50)) {
      // Look up pubkey for this swarmId
      const pubkey = this.feed.pubkeyToSwarmId
        ? Object.entries(this.feed.pubkeyToSwarmId).find(([pk, sid]) => sid === swarmId)?.[0]
        : null

      if (pubkey && this.feed.peerProfiles?.[pubkey]) {
        const p = this.feed.peerProfiles[pubkey]
        profiles[swarmId] = {
          name: p.name || null,
          bio: p.bio || null,
          avatar: p.avatar || null,
          website: p.website || null,
          pubkey
        }
      }
    }

    if (Object.keys(profiles).length > 0 && conn._fofMessage) {
      conn._fofMessage.send(b4a.from(JSON.stringify({
        type: 'profile_response',
        profiles
      })))
      console.log(`[FoF] Sent ${Object.keys(profiles).length} profiles for profile_request`)
    }
  }

  /**
   * Handle incoming profile response — resolve pending request
   */
  _handleProfileResponse(msg) {
    if (this._profileRequestCallback && msg.profiles) {
      clearTimeout(this._profileRequestTimeout)
      const callback = this._profileRequestCallback
      this._profileRequestCallback = null
      callback(msg.profiles)
    }
  }
}
