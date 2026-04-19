/**
 * Discovery - P2P user discovery via shared DHT topic
 * Users who enable discovery join a well-known topic and exchange profiles
 *
 * Enhanced with:
 * - Gossip protocol for sharing paid supporter listings
 * - Vouch system for trusted profile endorsement (paid listings only)
 * - Live peers tracking for real-time DHT connections
 *
 * Note: Profile caching now delegated to SupporterManager.
 * Only profiles with verified payment (listing.tx_proof) are cached/shared.
 */

import crypto from 'crypto'
import fs from 'fs'
import b4a from 'b4a'
import sodium from 'sodium-native'
import Protomux from 'protomux'
import c from 'compact-encoding'
import BloomFilter from './bloom-filter.js'
import { getSupporterManager } from './supporter-manager.js'
import { hexToPubkey, verify } from './identity.js'

// Well-known discovery topic - all discoverable users join this
export const DISCOVERY_TOPIC = crypto.createHash('sha256')
  .update('swarmnero-discovery-v1')
  .digest()

// Protocol name for discovery exchange via Protomux
const DISCOVERY_PROTOCOL = 'swarmnero-discovery-v3'

// Caps / limits
const MAX_PEERS = 5000
const MAX_HELLO_SKEW_MS = 5 * 60 * 1000
const MAX_NAME = 100
const MAX_BIO = 500
const MAX_AVATAR = 64 * 1024
const MAX_WEBSITE = 2048
const MAX_FOLLOW_LIST = 500

function _cap(s, n) { return typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : null }
function _randomNonceHex() {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

// Default cache max age: 30 days in milliseconds
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 * 1000

export class Discovery {
  constructor(swarm, identity) {
    this.swarm = swarm
    this.identity = identity
    this.enabled = false
    this.peers = new Map() // swarmId -> { profile, conn, lastSeen, pubkey, postCount, following, followers }
    this.myProfile = null
    this.mySwarmId = null
    this._myStats = null // { postCount, following: [{swarmId, name}], followers: [{swarmId, name}] }

    // Callbacks
    this.onPeerDiscovered = null
    this.onPeerLeft = null
    this.onPeerCountChanged = null

    // Track discovery connections separately
    this.discoveryConns = new Set()

    // Rate limiting for friends requests
    this._friendsRequestTimes = new Map() // peerId -> lastRequestTime

    // Cache and gossip state
    // Note: cachedProfiles is deprecated - profile storage now handled by SupporterManager
    // Keeping Map for potential legacy migration, but it's not actively used
    this.cachedProfiles = new Map() // deprecated: pubkey -> { profile, discoveryProfile, swarmId, lastSeen, vouched, vouchedBy, followedBy }
    this.myDiscoveryProfile = null
    this.cacheFilePath = null
    this.dataDir = null

    // Feed reference for friends-of-friends
    this.feed = null
    this.followingSwarmIds = new Set() // Swarm IDs we follow
  }

  /**
   * Set feed reference for friends-of-friends discovery
   */
  setFeed(feed) {
    this.feed = feed
    this._updateFollowingList()
  }

  /**
   * Set pre-computed stats for inclusion in hello messages.
   * Called from app.js after refreshUI computes profiles/timeline.
   * @param {{ postCount: number, following: Array<{swarmId, name}>, followers: Array<{swarmId, name}> }} stats
   */
  setStats(stats) {
    this._myStats = stats
  }

  /**
   * Update the list of swarm IDs we follow
   */
  _updateFollowingList() {
    if (!this.feed) return
    this.followingSwarmIds = new Set(this.feed.getFollowing())
  }

  /**
   * Get profiles of people we follow (for friends-of-friends sharing)
   * Returns array of { pubkey, profile, swarmId, listing } for our following list
   * Only includes profiles with verified listing (tx_proof).
   */
  _getMyFriendsProfiles() {
    if (!this.feed) return []

    const friends = []
    this._updateFollowingList()

    const supporterManager = getSupporterManager()
    const listings = supporterManager.getVerifiedListings()

    // Get profiles from verified listings that match our following list
    for (const swarmId of this.followingSwarmIds) {
      // Check if we have this profile in verified listings (by swarmId)
      for (const entry of listings) {
        if (entry.swarmId === swarmId && entry.listing?.tx_proof) {
          friends.push({
            pubkey: entry.pubkey,
            profile: entry.profile || {},
            discoveryProfile: {
              tags: entry.listing?.tags || [],
              tagline: entry.listing?.tagline || null,
              seq: entry.listing?.seq || 0
            },
            swarmId,
            listing: entry.listing // Include full listing data with tx_proof
          })
          break
        }
      }
    }

    // Limit to 20 profiles
    return friends.slice(0, 20)
  }

  /**
   * Set our profile info for sharing
   */
  setProfile(profile, swarmId) {
    this.myProfile = profile
    this.mySwarmId = swarmId

    // Send hello on any open channels where we haven't discovered the peer yet
    // This handles the case where channel opened before profile was loaded
    if (profile && this.enabled && this.swarm?.connections) {
      for (const conn of this.swarm.connections) {
        if (conn._discoveryChannel && !conn._discoveryChannel.closed && !conn._discoveryPeerSwarmId) {
          this._sendHello(conn)
        }
      }
    }
  }

  /**
   * Set the user's discovery profile to broadcast
   * Note: For actual supporter listing, payment proof is required.
   * Payment flow is handled in the UI (SupporterModal).
   */
  setMyDiscoveryProfile(discoveryProfile) {
    this.myDiscoveryProfile = discoveryProfile
  }

  /**
   * Set data directory and cache file path
   * Note: Local cache is deprecated. SupporterManager handles paid listing storage.
   */
  setDataDir(dataDir) {
    this.dataDir = dataDir
    this.cacheFilePath = `${dataDir}/discovery-cache.json`
    // Note: loadCache() no longer called - using SupporterManager instead
  }

  /**
   * Load cached profiles from disk
   * @deprecated - Passive caching removed. Using SupporterManager for paid listings.
   */
  loadCache() {
    // No-op: Passive caching has been removed.
    // Profile storage is now handled by SupporterManager for paid listings only.
    console.log('[Discovery] loadCache() deprecated - using SupporterManager for paid listings')
  }

  /**
   * Save cached profiles to disk
   * @deprecated - Passive caching removed. Using SupporterManager for paid listings.
   */
  saveCache() {
    // No-op: Passive caching has been removed.
    // Profile storage is now handled by SupporterManager for paid listings only.
  }

  /**
   * Mark a profile as vouched (endorsed by current user)
   * Only works for paid listings in SupporterManager.
   */
  vouchProfile(pubkey) {
    const supporterManager = getSupporterManager()
    supporterManager.vouchListing(pubkey)
  }

  /**
   * Remove vouch from a profile
   * Only works for paid listings in SupporterManager.
   */
  unvouchProfile(pubkey) {
    const supporterManager = getSupporterManager()
    supporterManager.unvouchListing(pubkey)
  }

  /**
   * Check if a profile is vouched by the current user
   * @param {string} pubkey - The pubkey to check
   * @returns {boolean} True if vouched
   */
  isVouched(pubkey) {
    const supporterManager = getSupporterManager()
    const listing = supporterManager.getListing(pubkey)
    return listing?.vouched || false
  }

  /**
   * Get cached profiles (paid supporter listings only)
   * Now returns profiles from SupporterManager instead of local cache.
   * @param {Object} options - Filter options
   * @param {string} options.tag - Filter by tag
   * @returns {Array} Array of verified paid listings
   */
  getCachedProfiles(options = {}) {
    const supporterManager = getSupporterManager()
    const listings = supporterManager.getVerifiedListings(options)

    // Map to expected format for backwards compatibility
    return listings.map(listing => ({
      pubkey: listing.pubkey,
      profile: listing.profile || {},
      discoveryProfile: {
        tags: listing.listing?.tags || [],
        tagline: listing.listing?.tagline || null,
        seq: listing.listing?.seq || 0
      },
      swarmId: listing.swarmId,
      lastSeen: listing.verifiedAt || Date.now(),
      vouched: listing.vouched || false,
      vouchedBy: listing.vouchedBy || [],
      listing: listing.listing // Include full listing data with tx_proof
    }))
  }

  /**
   * Create a bloom filter from all verified listing pubkeys
   * @returns {BloomFilter} Bloom filter containing all listing pubkeys
   */
  getBloomFilter() {
    const filter = new BloomFilter()
    const supporterManager = getSupporterManager()
    const listings = supporterManager.getVerifiedListings()

    for (const listing of listings) {
      filter.add(listing.pubkey)
    }

    return filter
  }

  /**
   * Get profiles to send in gossip exchange
   * Only includes profiles with verified listing data (tx_proof).
   * @param {BloomFilter} theirBloomFilter - Their bloom filter
   * @returns {Array} Profiles to send (max 20)
   */
  getGossipPayload(theirBloomFilter) {
    const toSend = []
    const supporterManager = getSupporterManager()
    const listings = supporterManager.getVerifiedListings()

    // First, add vouched listings
    for (const entry of listings) {
      if (!entry.listing?.tx_proof) continue // Only share paid listings

      if (entry.vouched) {
        toSend.push({
          pubkey: entry.pubkey,
          profile: entry.profile,
          discoveryProfile: {
            tags: entry.listing?.tags || [],
            tagline: entry.listing?.tagline || null,
            seq: entry.listing?.seq || 0
          },
          swarmId: entry.swarmId,
          vouchedBy: entry.vouchedBy || [],
          listing: entry.listing // Include full listing data with tx_proof
        })
      }
    }

    // Then add listings they might not have (not in their bloom filter)
    for (const entry of listings) {
      if (toSend.length >= 20) break
      if (!entry.listing?.tx_proof) continue // Only share paid listings
      if (entry.vouched) continue // Already added

      // If they might have it, skip
      if (theirBloomFilter && theirBloomFilter.mightContain(entry.pubkey)) continue

      toSend.push({
        pubkey: entry.pubkey,
        profile: entry.profile,
        discoveryProfile: {
          tags: entry.listing?.tags || [],
          tagline: entry.listing?.tagline || null,
          seq: entry.listing?.seq || 0
        },
        swarmId: entry.swarmId,
        vouchedBy: entry.vouchedBy || [],
        listing: entry.listing // Include full listing data with tx_proof
      })
    }

    return toSend.slice(0, 20)
  }

  /**
   * Enable discovery - join the discovery topic and set up Protomux on all connections
   */
  enable() {
    if (this.enabled) return
    this.enabled = true

    console.log('[Discovery] Enabling - joining discovery topic')

    // Join the discovery topic
    this.swarm.join(DISCOVERY_TOPIC)

    // Set up Protomux on all new connections
    this._connectionHandler = (conn, info) => {
      this._setupProtomux(conn)
    }
    this.swarm.on('connection', this._connectionHandler)

    // Set up Protomux on all existing connections
    if (this.swarm.connections) {
      for (const conn of this.swarm.connections) {
        if (!conn.destroyed) this._setupProtomux(conn)
      }
    }

    // Retry interval for connections where channel failed or hello not exchanged
    // Short warmup since Discovery is already delayed 5s after startup
    this._retryTimeout = setTimeout(() => {
      this._retryInterval = setInterval(() => {
        this._retryAllConnections()
      }, 10000)
    }, 5000)

    this.swarm.flush().then(() => {
      console.log('[Discovery] Joined discovery topic')
    })
  }

  /**
   * Set up Protomux channel on a connection for discovery
   */
  _setupProtomux(conn) {
    if (conn._isInfrastructure) return
    if (conn._discoveryChannel && !conn._discoveryChannel.closed) return
    if (conn._discoveryPaired) return

    try {
      const mux = Protomux.from(conn)
      if (mux.destroyed) return

      conn._discoveryPaired = true

      // Listen for remote peer requesting discovery protocol
      mux.pair({ protocol: DISCOVERY_PROTOCOL }, () => {
        console.log('[Discovery] Remote peer requested discovery channel')
        this._createDiscoveryChannel(mux, conn)
      })

      // Also initiate channel ourselves
      this._createDiscoveryChannel(mux, conn)
    } catch (err) {
      console.error('[Discovery] Error setting up Protomux:', err.message)
    }
  }

  /**
   * Create and open a discovery channel on a mux instance
   */
  _createDiscoveryChannel(mux, conn) {
    if (conn._discoveryChannel && !conn._discoveryChannel.closed) return

    const channel = mux.createChannel({
      protocol: DISCOVERY_PROTOCOL,
      unique: true,
      onopen: () => {
        console.log('[Discovery] Channel opened with peer')
        // Send immediately and again after delay to maximize delivery
        this._sendHello(conn)
        setTimeout(() => this._sendHello(conn), 500)
      },
      onclose: () => {
        console.log('[Discovery] Channel closed')
        conn._discoveryChannel = null
        conn._discoveryMessage = null
      }
    })

    if (!channel) return

    const message = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this._handleMessage(msg, conn)
      }
    })

    conn._discoveryChannel = channel
    conn._discoveryMessage = message

    channel.open()

    // Track connection lifecycle
    conn.once('close', () => {
      const peerSwarmId = conn._discoveryPeerSwarmId
      if (peerSwarmId) {
        this.peers.delete(peerSwarmId)
        this.onPeerLeft?.(peerSwarmId)
        this.onPeerCountChanged?.(this.peers.size)
        console.log('[Discovery] Peer left:', peerSwarmId.slice(0, 8))
      }
    })
  }

  /**
   * Send discovery-hello to a peer
   */
  _sendHello(conn) {
    if (!conn._discoveryMessage) {
      console.log('[Discovery] Cannot send hello: no message channel')
      return
    }
    if (!this.myProfile || !this.mySwarmId) {
      console.log('[Discovery] Cannot send hello: profile not set yet')
      return
    }

    const bloomFilter = this.getBloomFilter()
    const stats = this._myStats || {}
    const payload = {
      type: 'discovery-hello',
      swarmId: this.mySwarmId,
      pubkey: this.identity.pubkeyHex,
      profile: {
        name: _cap(this.myProfile.name, MAX_NAME),
        bio: _cap(this.myProfile.bio, MAX_BIO),
        avatar: _cap(this.myProfile.avatar, MAX_AVATAR),
        website: _cap(this.myProfile.website, MAX_WEBSITE)
      },
      postCount: stats.postCount || 0,
      following: (stats.following || []).slice(0, MAX_FOLLOW_LIST),
      followers: (stats.followers || []).slice(0, MAX_FOLLOW_LIST),
      discoveryProfile: this.myDiscoveryProfile,
      bloom: Array.from(bloomFilter.toBuffer()),
      timestamp: Date.now(),
      nonce: _randomNonceHex()
    }

    // Sign the payload with our Ed25519 identity key so the receiver can
    // verify that (pubkey, swarmId, profile, stats) are actually asserted by
    // the holder of `pubkey`. Without this any sybil can claim any swarmId.
    const signedFields = {
      swarmId: payload.swarmId,
      pubkey: payload.pubkey,
      profile: payload.profile,
      postCount: payload.postCount,
      following: payload.following,
      followers: payload.followers,
      timestamp: payload.timestamp,
      nonce: payload.nonce
    }
    payload.signature = b4a.toString(this.identity.sign(JSON.stringify(signedFields)), 'hex')

    conn._discoveryMessage.send(payload)
  }

  /**
   * Handle incoming discovery messages via Protomux
   */
  _handleMessage(msg, conn) {
    if (msg.type === 'discovery-hello' && msg.swarmId) {
      if (msg.swarmId === this.mySwarmId) return

      // Validate shape
      if (typeof msg.swarmId !== 'string' || !/^[a-f0-9]{64}$/i.test(msg.swarmId)) return
      if (typeof msg.pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(msg.pubkey)) return
      if (typeof msg.signature !== 'string' || !/^[a-f0-9]{128}$/i.test(msg.signature)) return
      if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) return
      if (typeof msg.nonce !== 'string' || msg.nonce.length > 128) return
      if (Math.abs(Date.now() - msg.timestamp) > MAX_HELLO_SKEW_MS) return

      // Normalize / truncate untrusted fields before signature check so that
      // the payload the sender signed is what we observe here.
      const profile = msg.profile && typeof msg.profile === 'object' ? {
        name: _cap(msg.profile.name, MAX_NAME),
        bio: _cap(msg.profile.bio, MAX_BIO),
        avatar: _cap(msg.profile.avatar, MAX_AVATAR),
        website: _cap(msg.profile.website, MAX_WEBSITE)
      } : {}
      const following = Array.isArray(msg.following) ? msg.following.slice(0, MAX_FOLLOW_LIST) : []
      const followers = Array.isArray(msg.followers) ? msg.followers.slice(0, MAX_FOLLOW_LIST) : []
      const postCount = typeof msg.postCount === 'number' ? msg.postCount : 0

      // Signature must be over the NORMALIZED view the sender should have
      // produced. If a peer ships oversized fields, the signature will not
      // match the truncated view and we reject.
      try {
        const signedFields = {
          swarmId: msg.swarmId,
          pubkey: msg.pubkey,
          profile: {
            name: msg.profile?.name || null,
            bio: msg.profile?.bio || null,
            avatar: msg.profile?.avatar || null,
            website: msg.profile?.website || null
          },
          postCount,
          following: Array.isArray(msg.following) ? msg.following : [],
          followers: Array.isArray(msg.followers) ? msg.followers : [],
          timestamp: msg.timestamp,
          nonce: msg.nonce
        }
        const sigBuf = b4a.from(msg.signature, 'hex')
        const pkBuf = hexToPubkey(msg.pubkey)
        if (!verify(JSON.stringify(signedFields), sigBuf, pkBuf)) {
          console.warn('[Discovery] Rejected discovery-hello: bad signature from', msg.pubkey.slice(0, 8))
          return
        }
      } catch (err) {
        console.warn('[Discovery] Signature verification error:', err.message)
        return
      }

      // LRU-bound peers map
      if (this.peers.size >= MAX_PEERS && !this.peers.has(msg.swarmId)) {
        const oldestKey = this.peers.keys().next().value
        if (oldestKey) this.peers.delete(oldestKey)
      }

      // Skip if we already know this peer (by swarmId globally, not per-connection)
      const alreadyKnown = this.peers.has(msg.swarmId)

      conn._discoveryPeerSwarmId = msg.swarmId

      this.peers.set(msg.swarmId, {
        profile,
        pubkey: msg.pubkey,
        postCount,
        following,
        followers,
        conn: conn,
        lastSeen: Date.now()
      })

      if (!alreadyKnown) {
        console.log('[Discovery] Discovered peer:', profile?.name || msg.swarmId.slice(0, 8))

        this.onPeerDiscovered?.({
          swarmId: msg.swarmId,
          pubkey: msg.pubkey,
          profile,
          postCount,
          following,
          followers
        })
        this.onPeerCountChanged?.(this.peers.size)

        // Send gossip payload if they included bloom filter
        if (msg.bloom && conn._discoveryMessage) {
          try {
            const theirBloom = BloomFilter.fromBuffer(new Uint8Array(msg.bloom))
            const payload = this.getGossipPayload(theirBloom)
            if (payload.length > 0) {
              conn._discoveryMessage.send({
                type: 'discovery-profiles',
                profiles: payload
              })
              console.log(`[Discovery] Sent ${payload.length} profiles via gossip`)
            }
          } catch (bloomErr) {
            console.warn('[Discovery] Failed to parse bloom filter:', bloomErr.message)
          }
        }

        // Friends-of-friends: if we follow this peer, request their following list
        this._updateFollowingList()
        if (this.followingSwarmIds.has(msg.swarmId) && conn._discoveryMessage) {
          conn._discoveryMessage.send({ type: 'discovery-friends-request' })
          console.log(`[Discovery] Requesting friends from ${msg.profile?.name || msg.swarmId.slice(0, 8)}`)
        }
      }
    }

    // Handle gossip profiles
    if (msg.type === 'discovery-profiles' && Array.isArray(msg.profiles)) {
      console.log(`[Discovery] Received ${msg.profiles.length} profiles via gossip`)

      const supporterManager = getSupporterManager()
      let addedCount = 0

      for (const p of msg.profiles) {
        if (!p.pubkey || p.pubkey === this.mySwarmId) continue
        if (!p.listing?.tx_proof) continue

        // On-chain verify before trusting the listing. If the wallet is
        // locked or the proof is bogus, addPeerListing stores it as
        // unverified and it won't count as a supporter.
        supporterManager.addPeerListing(p.pubkey, p.profile || {}, p.listing, p.swarmId)
          .then(verified => { if (verified) addedCount++ })
          .catch(() => {})
      }

      if (addedCount > 0) {
        console.log(`[Discovery] Added ${addedCount} verified listings from gossip`)
      }
    }

    // Handle friends-of-friends request (rate limited)
    if (msg.type === 'discovery-friends-request') {
      const peerId = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : 'unknown'
      const now = Date.now()
      const lastReq = this._friendsRequestTimes.get(peerId)
      if (lastReq && (now - lastReq) < 10_000) {
        return // 10s rate limit per peer
      }
      this._friendsRequestTimes.set(peerId, now)

      const friends = this._getMyFriendsProfiles()
      if (friends.length > 0 && conn._discoveryMessage) {
        conn._discoveryMessage.send({
          type: 'discovery-friends',
          fromSwarmId: this.mySwarmId,
          fromName: this.myProfile?.name || null,
          profiles: friends
        })
        console.log(`[Discovery] Sent ${friends.length} friends to peer`)
      }
    }

    // Handle friends-of-friends response
    if (msg.type === 'discovery-friends' && Array.isArray(msg.profiles)) {
      const friendName = msg.fromName || msg.fromSwarmId?.slice(0, 8) || 'friend'
      console.log(`[Discovery] Received ${msg.profiles.length} friends-of-friends from ${friendName}`)

      const supporterManager = getSupporterManager()
      let addedCount = 0

      for (const p of msg.profiles) {
        if (!p.pubkey || p.pubkey === this.mySwarmId) continue
        if (!p.listing?.tx_proof) continue

        // On-chain verify before trusting the listing. If the wallet is
        // locked or the proof is bogus, addPeerListing stores it as
        // unverified and it won't count as a supporter.
        supporterManager.addPeerListing(p.pubkey, p.profile || {}, p.listing, p.swarmId)
          .then(verified => { if (verified) addedCount++ })
          .catch(() => {})
      }

      if (addedCount > 0) {
        console.log(`[Discovery] Added ${addedCount} friend listings from ${friendName}`)
      }
    }
  }

  /**
   * Retry discovery channel setup on all active connections
   * Also re-sends hello on open channels that haven't exchanged yet
   */
  _retryAllConnections() {
    if (!this.swarm?.connections) return

    for (const conn of this.swarm.connections) {
      if (conn.destroyed) continue
      if (conn._isInfrastructure) continue

      if (!conn._discoveryChannel || conn._discoveryChannel.closed) {
        if (conn._discoveryPaired) {
          const mux = Protomux.from(conn)
          if (!mux.destroyed) {
            this._createDiscoveryChannel(mux, conn)
          }
        } else {
          this._setupProtomux(conn)
        }
      } else if (!conn._discoveryPeerSwarmId && this.myProfile) {
        // Channel is open but no hello exchanged yet — retry
        this._sendHello(conn)
      }
    }
  }

  /**
   * Disable discovery - leave the discovery topic
   */
  disable() {
    if (!this.enabled) return
    this.enabled = false

    console.log('[Discovery] Disabling - leaving discovery topic')

    this.swarm.leave(DISCOVERY_TOPIC)

    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout)
      this._retryTimeout = null
    }
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }

    if (this._connectionHandler) {
      this.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    this.peers.clear()
    this.onPeerCountChanged?.(0)
  }

  /**
   * Get list of discovered peers
   */
  getPeers() {
    const result = []
    for (const [swarmId, data] of this.peers) {
      result.push({
        swarmId,
        profile: data.profile,
        pubkey: data.pubkey || null,
        postCount: data.postCount || 0,
        following: data.following || [],
        followers: data.followers || [],
        lastSeen: data.lastSeen
      })
    }
    // Sort by name, then by swarmId
    result.sort((a, b) => {
      const nameA = a.profile?.name || ''
      const nameB = b.profile?.name || ''
      if (nameA && nameB) return nameA.localeCompare(nameB)
      if (nameA) return -1
      if (nameB) return 1
      return a.swarmId.localeCompare(b.swarmId)
    })
    return result
  }

  /**
   * Get count of discovered peers
   */
  get peerCount() {
    return this.peers.size
  }

  /**
   * Check if discovery is enabled
   */
  get isEnabled() {
    return this.enabled
  }
}
