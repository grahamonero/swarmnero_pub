/**
 * DM Manager - End-to-end encrypted direct messaging using two Hypercores per conversation
 *
 * Architecture:
 * - Each conversation has TWO Hypercores: one per participant (outbox model)
 * - Each user writes to their own "outbox" core
 * - Keys are exchanged via Protomux channel on connection
 * - Both cores are replicated between peers
 * - Messages from both cores are merged by timestamp when reading
 * - Encryption: X25519 DH shared key + crypto_secretbox
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import sodium from 'sodium-native'
import { sign, pubkeyToHex, hexToPubkey, verify } from './identity.js'
import {
  deriveDMKey,
  deriveX25519Keys,
  deriveSharedKey,
  encryptMessage,
  decryptMessage
} from './dm-crypto.js'

/**
 * DM event types
 */
export const DMEventType = {
  MESSAGE: 'dm_message',
  MEDIA: 'dm_media',
  READ: 'dm_read'
}

// Protocol name for DM key exchange
const DM_PROTOCOL = 'swarmnero-dm-v2'

// Maximum acceptable clock skew for signed announcements (5 minutes)
const MAX_ANNOUNCEMENT_SKEW_MS = 5 * 60 * 1000

function _randomNonceHex() {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

export class DM {
  constructor(store, swarm, identity) {
    // Create a namespaced store for DM to avoid conflicts with main feed
    this.store = store.namespace('dm')
    this.swarm = swarm
    this.identity = identity
    this.conversations = new Map() // otherPubkeyHex -> { myCore, theirCore, topic, sharedKey }
    this.topicToConversation = new Map() // topicHex -> otherPubkeyHex
    this.pendingConversations = new Map() // otherPubkeyHex -> { resolve, reject } for key exchange
    this.x25519Keys = null
    this.dataDir = null
    this.dmStateDir = null
    this.dmState = { lastRead: {}, blocked: [], muted: [], knownKeys: {} }
    this.onDataUpdate = null // callback for new messages
    this._connectionHandler = null
    this.feed = null // Reference to main feed for mutual follow checks
    this.pubkeyToSwarmId = {} // Mapping from pubkey to swarmId for mutual follow checks
  }

  /**
   * Update the pubkey to swarmId mapping (called from UI after getPeerProfiles)
   */
  setPubkeyToSwarmId(mapping) {
    this.pubkeyToSwarmId = mapping || {}
  }

  /**
   * Check if we can DM a user (requires mutual follow)
   * @param {string} pubkeyHex - Other user's pubkey
   * @returns {boolean}
   */
  canDM(pubkeyHex) {
    if (!this.feed) return false
    return this.feed.canDM(pubkeyHex, this.pubkeyToSwarmId)
  }

  /**
   * Initialize the DM manager
   * @param {string} dataDir - Base data directory
   * @param {Object} feed - Reference to main Feed instance for mutual follow checks
   */
  async init(dataDir, feed = null) {
    this.dataDir = dataDir
    this.dmStateDir = path.join(dataDir, 'dm-state')
    this.feed = feed

    // Ensure dm-state directory exists
    try {
      fs.mkdirSync(this.dmStateDir, { recursive: true })
    } catch (e) {
      // ignore if exists
    }

    // Derive X25519 keys from Ed25519 identity
    this.x25519Keys = deriveX25519Keys(this.identity.secretKey)

    // Load DM state (lastRead, blocked, muted, knownKeys)
    await this._loadState()

    // Restore conversations from knownKeys (fix: conversations should persist)
    await this._restoreConversations()

    // Set up connection handler for DM
    this._connectionHandler = (conn, info) => {
      this._handleConnection(conn, info)
    }
    this.swarm.on('connection', this._connectionHandler)

    // Set up Protomux on all existing connections
    // This ensures we can receive DM announcements even before creating conversations
    if (this.swarm.connections) {
      for (const conn of this.swarm.connections) {
        this._setupProtomux(conn)
      }
    }

    // Periodically retry setting up DM channels on all connections
    // Delayed start to avoid churn during Hyperswarm connection deduplication
    this._retryTimeout = setTimeout(() => {
      this._retryInterval = setInterval(() => {
        this._retryAllConnections()
      }, 10000)
    }, 30000)

    return this
  }

  /**
   * Retry DM channel setup on all active connections
   */
  _retryAllConnections() {
    if (!this.swarm?.connections) return

    for (const conn of this.swarm.connections) {
      if (conn.destroyed) continue
      if (conn._isInfrastructure) continue

      if (!conn._dmChannel || conn._dmChannel.closed) {
        if (conn._dmPaired) {
          // Pair listener exists, just try to create channel
          const mux = Protomux.from(conn)
          if (!mux.destroyed) {
            this._createDMChannel(mux, conn)
          }
        } else {
          this._setupProtomux(conn)
        }
      }
    }
  }

  /**
   * Handle swarm connections - set up Protomux and replicate DM cores
   */
  _handleConnection(conn, info) {
    // Skip infrastructure connections (e.g. sync server) - they don't speak DM
    if (conn._isInfrastructure) return

    console.log('[DM] Connection received')

    // Set up Protomux channel for key exchange
    this._setupProtomux(conn)

    // Replicate existing conversation cores over this new connection
    for (const [pubkey, conversation] of this.conversations) {
      if (conversation.myCore) {
        console.log(`[DM] Replicating my core for ${pubkey.slice(0, 8)}... over connection`)
        conversation.myCore.replicate(conn)
      }
      if (conversation.theirCore) {
        console.log(`[DM] Replicating their core for ${pubkey.slice(0, 8)}... over connection`)
        conversation.theirCore.replicate(conn)
      }
    }
  }

  /**
   * Set up Protomux channel on a connection for DM key exchange
   */
  _setupProtomux(conn) {
    // Skip infrastructure connections (e.g. sync server)
    if (conn._isInfrastructure) return

    // Skip if already set up and channel is still open
    if (conn._dmChannel && !conn._dmChannel.closed) {
      return
    }

    // Skip if pair listener already set up
    if (conn._dmPaired) {
      return
    }

    console.log('[DM] Setting up Protomux channel')

    try {
      const mux = Protomux.from(conn)

      if (mux.destroyed) {
        console.log('[DM] Mux already destroyed, skipping')
        return
      }

      // Mark that we've set up the pair listener for this connection
      conn._dmPaired = true

      // Listen for the remote peer trying to open this protocol
      mux.pair({ protocol: DM_PROTOCOL }, () => {
        console.log('[DM] Remote peer requested DM channel, creating response channel')
        this._createDMChannel(mux, conn)
      })

      // Also initiate the channel ourselves
      this._createDMChannel(mux, conn)
    } catch (err) {
      console.error('[DM] Error setting up Protomux:', err.message)
    }
  }

  /**
   * Create and open a DM channel on a mux instance
   */
  _createDMChannel(mux, conn) {
    // Skip if channel already exists and is open
    if (conn._dmChannel && !conn._dmChannel.closed) {
      return
    }

    const channel = mux.createChannel({
      protocol: DM_PROTOCOL,
      unique: true,
      onopen: () => {
        console.log('[DM] Protocol channel opened with peer')
        this._announceCoresToPeer(conn)
      },
      onclose: () => {
        console.log('[DM] Protocol channel closed')
        conn._dmChannel = null
        conn._dmKeyMessage = null
      }
    })

    if (!channel) {
      console.log('[DM] Failed to create channel')
      return
    }

    const keyMessage = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this._handleKeyAnnouncement(msg, conn)
      }
    })

    conn._dmChannel = channel
    conn._dmKeyMessage = keyMessage

    channel.open()
    console.log('[DM] Channel opened, waiting for remote...')
  }

  /**
   * Sign a dm-core announcement with our Ed25519 key.
   * Includes timestamp + nonce so the receiver can reject replays.
   */
  _signedAnnouncement(toPubkey, coreKey) {
    const msg = {
      type: 'dm-core',
      fromPubkey: this.identity.pubkeyHex,
      toPubkey,
      coreKey,
      timestamp: Date.now(),
      nonce: _randomNonceHex()
    }
    const payload = JSON.stringify({
      type: msg.type,
      fromPubkey: msg.fromPubkey,
      toPubkey: msg.toPubkey,
      coreKey: msg.coreKey,
      timestamp: msg.timestamp,
      nonce: msg.nonce
    })
    msg.signature = b4a.toString(this.identity.sign(payload), 'hex')
    return msg
  }

  /**
   * Announce our DM cores to a peer via Protomux
   */
  _announceCoresToPeer(conn) {
    if (!conn._dmKeyMessage) {
      console.log('[DM] Cannot announce - no keyMessage on connection')
      return
    }

    // Announce all our conversation cores (Push)
    for (const [otherPubkey, conversation] of this.conversations) {
      if (conversation.myCore?.key) {
        const announcement = this._signedAnnouncement(otherPubkey, b4a.toString(conversation.myCore.key, 'hex'))
        console.log(`[DM] Announcing core for conversation with ${otherPubkey.slice(0, 8)}...`)
        conn._dmKeyMessage.send(announcement)
      }

      // Request keys we are missing (Pull)
      // If we have a conversation but don't have their core, ask for it
      const kEntry = this.dmState.knownKeys[otherPubkey]
      const kCoreKey = (kEntry && typeof kEntry === 'object') ? kEntry.coreKey : kEntry
      if (!conversation.theirCore && !kCoreKey) {
        console.log(`[DM] Requesting key from ${otherPubkey.slice(0, 8)}...`)
        conn._dmKeyMessage.send({
          type: 'dm-request-key',
          fromPubkey: this.identity.pubkeyHex
        })
      }
    }
  }

  /**
   * Handle incoming key announcement or request from peer
   */
  async _handleKeyAnnouncement(msg, conn) {
    console.log('[DM] Received message:', msg.type, 'from', msg.fromPubkey?.slice(0, 8))

    // Handle key request - they're asking for our key
    if (msg.type === 'dm-request-key') {
      const conversation = this.conversations.get(msg.fromPubkey)
      if (conversation?.myCore?.key && conn._dmKeyMessage) {
        console.log(`[DM] Responding to key request from ${msg.fromPubkey.slice(0, 8)}...`)
        conn._dmKeyMessage.send(this._signedAnnouncement(msg.fromPubkey, b4a.toString(conversation.myCore.key, 'hex')))
      }
      return
    }

    if (msg.type !== 'dm-core') return

    const { fromPubkey, toPubkey, coreKey, timestamp, nonce, signature } = msg

    // Validate field shapes before doing any work
    if (typeof fromPubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(fromPubkey)) return
    if (typeof toPubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(toPubkey)) return
    if (typeof coreKey !== 'string' || !/^[a-f0-9]{64}$/i.test(coreKey)) return

    // Verify this announcement is for us — silently ignore if not
    if (toPubkey !== this.identity.pubkeyHex) return

    // Reject unsigned announcements unconditionally. A MITM peer joining the
    // DM topic could otherwise spoof a `dm-core` for any pubkey and have us
    // replicate from an attacker-controlled core.
    if (typeof signature !== 'string' || typeof timestamp !== 'number' || typeof nonce !== 'string') {
      console.warn(`[DM] Rejected unsigned key announcement from ${fromPubkey.slice(0, 8)}`)
      return
    }

    // Reject replay or large clock skew
    const now = Date.now()
    if (Math.abs(now - timestamp) > MAX_ANNOUNCEMENT_SKEW_MS) {
      console.warn(`[DM] Rejected key announcement from ${fromPubkey.slice(0, 8)}: timestamp skew`)
      return
    }
    const knownEntry = this.dmState.knownKeys[fromPubkey]
    const knownTs = (knownEntry && typeof knownEntry === 'object') ? (knownEntry.ts || 0) : 0
    if (timestamp <= knownTs) {
      // Older or duplicate announcement — protect against replay of stale keys
      return
    }

    // Verify signature
    try {
      const payload = JSON.stringify({ type: 'dm-core', fromPubkey, toPubkey, coreKey, timestamp, nonce })
      const sigBuf = b4a.from(signature, 'hex')
      const pubBuf = hexToPubkey(fromPubkey)
      if (!verify(payload, sigBuf, pubBuf)) {
        console.warn(`[DM] Invalid signature on key announcement from ${fromPubkey.slice(0, 8)}`)
        return
      }
    } catch (err) {
      console.warn(`[DM] Signature verification error: ${err.message}`)
      return
    }

    // Skip if we already have this exact key (prevents echo loops)
    const knownCoreKey = (knownEntry && typeof knownEntry === 'object') ? knownEntry.coreKey : knownEntry
    if (knownCoreKey === coreKey) return

    // --- IMMEDIATE ECHO (before any async work) ---
    // If we have a conversation/core for this peer, send our key back once.
    const existingConv = this.conversations.get(fromPubkey)
    if (conn._dmKeyMessage && existingConv?.myCore?.key) {
      console.log(`[DM] Echoing our key to ${fromPubkey.slice(0, 8)}...`)
      conn._dmKeyMessage.send(this._signedAnnouncement(fromPubkey, b4a.toString(existingConv.myCore.key, 'hex')))
    }
    // --- END IMMEDIATE ECHO ---

    // Store key + latest-seen timestamp; won't echo again for same key and
    // future announcements with older ts are rejected as replays.
    this.dmState.knownKeys[fromPubkey] = { coreKey, ts: timestamp }
    await this._saveState()

    console.log(`[DM] Stored core key for ${fromPubkey.slice(0, 8)}...: ${coreKey.slice(0, 16)}...`)

    // If we have a conversation with this peer, set up their core
    if (this.conversations.has(fromPubkey)) {
      const conversation = this.conversations.get(fromPubkey)
      if (!conversation.theirCore) {
        await this._setupTheirCore(fromPubkey, coreKey, conn)
        // Wait for initial sync, then trigger UI update
        if (conversation.theirCore) {
          await conversation.theirCore.update()
          console.log(`[DM] Peer core synced, length: ${conversation.theirCore.length}`)
          if (this.onDataUpdate) {
            this.onDataUpdate(fromPubkey)
          }
        }
      }
      // Note: We already sent fast echo above, no need to send again
    } else {
      // Create conversation when receiving first DM from a mutual follow
      if (this.canDM(fromPubkey)) {
        console.log(`[DM] Creating conversation for incoming DM from ${fromPubkey.slice(0, 8)}...`)
        await this.getConversation(fromPubkey)
        // Now set up their core with the key we just received
        if (this.conversations.has(fromPubkey)) {
          const conv = this.conversations.get(fromPubkey)
          await this._setupTheirCore(fromPubkey, coreKey, conn)

          // Late echo - we just created the conversation, so send our key now
          if (conn._dmKeyMessage && conv.myCore?.key) {
            console.log(`[DM] Late echo to ${fromPubkey.slice(0, 8)}...`)
            conn._dmKeyMessage.send(this._signedAnnouncement(fromPubkey, b4a.toString(conv.myCore.key, 'hex')))
          }

          // Wait briefly for initial sync, then trigger UI update
          if (conv?.theirCore) {
            await conv.theirCore.update()
            console.log(`[DM] Initial sync complete, their core length: ${conv.theirCore.length}`)
          }
          if (this.onDataUpdate) {
            this.onDataUpdate(fromPubkey)
          }
        }
      }
    }

    // Resolve any pending conversation setup
    if (this.pendingConversations.has(fromPubkey)) {
      const { resolve } = this.pendingConversations.get(fromPubkey)
      this.pendingConversations.delete(fromPubkey)
      resolve()
    }
  }

  /**
   * Set up the peer's core for reading
   */
  async _setupTheirCore(otherPubkeyHex, coreKeyHex, conn) {
    const conversation = this.conversations.get(otherPubkeyHex)
    if (!conversation) return

    console.log(`[DM] Setting up their core for ${otherPubkeyHex.slice(0, 8)}...`)

    const coreKey = b4a.from(coreKeyHex, 'hex')
    const theirCore = conversation.convStore.get({ key: coreKey, valueEncoding: 'json' })
    await theirCore.ready()

    console.log(`[DM] Their core ready, length: ${theirCore.length}, key: ${coreKeyHex.slice(0, 16)}...`)

    // Listen for new messages
    theirCore.on('append', () => {
      console.log(`[DM] New message from ${otherPubkeyHex.slice(0, 8)}...`)
      if (this.onDataUpdate) this.onDataUpdate(otherPubkeyHex)
    })

    conversation.theirCore = theirCore

    // Start replication
    if (conn) {
      theirCore.replicate(conn)
    }

    // Also replicate over all existing connections
    if (this.swarm.connections) {
      for (const c of this.swarm.connections) {
        theirCore.replicate(c)
      }
    }
  }

  /**
   * Load DM state from disk
   */
  async _loadState() {
    const statePath = path.join(this.dmStateDir, `${this.identity.pubkeyHex}.json`)
    try {
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        this.dmState = {
          lastRead: data.lastRead || {},
          blocked: data.blocked || [],
          muted: data.muted || [],
          knownKeys: data.knownKeys || {}
        }
      }
    } catch (err) {
      console.error('Error loading DM state:', err.message)
    }
  }

  /**
   * Save DM state to disk
   */
  async _saveState() {
    const statePath = path.join(this.dmStateDir, `${this.identity.pubkeyHex}.json`)
    try {
      fs.writeFileSync(statePath, JSON.stringify(this.dmState, null, 2), 'utf8')
    } catch (err) {
      console.error('Error saving DM state:', err.message)
    }
  }

  /**
   * Restore conversations from persisted knownKeys
   * This fixes the bug where conversations don't show on restart
   */
  async _restoreConversations() {
    const knownKeys = this.dmState.knownKeys || {}
    const pubkeys = Object.keys(knownKeys)

    if (pubkeys.length === 0) {
      console.log('[DM] No conversations to restore')
      return
    }

    console.log(`[DM] Restoring ${pubkeys.length} conversation(s) from knownKeys...`)

    for (const pubkeyHex of pubkeys) {
      // Skip blocked users
      if (this.dmState.blocked.includes(pubkeyHex)) continue

      try {
        // getConversation will set up the conversation and their core from knownKeys
        await this.getConversation(pubkeyHex)
        console.log(`[DM] Restored conversation with ${pubkeyHex.slice(0, 8)}...`)
      } catch (err) {
        console.warn(`[DM] Failed to restore conversation with ${pubkeyHex.slice(0, 8)}...:`, err.message)
      }
    }
  }

  /**
   * Get or create a conversation with another user
   * @param {string} otherPubkeyHex - Other user's Ed25519 public key (hex)
   * @returns {Promise<{ myCore, theirCore, topic, sharedKey }>}
   */
  async getConversation(otherPubkeyHex) {
    // Return cached conversation if exists
    if (this.conversations.has(otherPubkeyHex)) {
      console.log(`[DM] Using cached conversation with ${otherPubkeyHex.slice(0, 8)}...`)
      return this.conversations.get(otherPubkeyHex)
    }

    console.log(`[DM] Creating new conversation with ${otherPubkeyHex.slice(0, 8)}...`)

    // Check if blocked
    if (this.dmState.blocked.includes(otherPubkeyHex)) {
      throw new Error('User is blocked')
    }

    // Derive deterministic conversation ID and topic from both pubkeys
    const dmKey = deriveDMKey(this.identity.pubkeyHex, otherPubkeyHex)
    const convId = b4a.toString(dmKey, 'hex')

    // Create namespaced store for this conversation
    const convStore = this.store.namespace(convId.slice(0, 16))

    // Create my outbox core (I write, they read)
    const myCore = convStore.get({
      name: 'outbox-' + this.identity.pubkeyHex.slice(0, 16),
      valueEncoding: 'json'
    })
    await myCore.ready()
    console.log(`[DM] My core ready, length: ${myCore.length}, writable: ${myCore.writable}`)
    console.log(`[DM] My core key: ${b4a.toString(myCore.key, 'hex').slice(0, 16)}...`)

    // Join swarm using the deterministic topic
    const topic = dmKey
    const topicHex = b4a.toString(topic, 'hex')
    console.log(`[DM] Joining swarm topic: ${topicHex.slice(0, 16)}...`)
    this.swarm.join(topic)

    // Track topic -> pubkey mapping
    this.topicToConversation.set(topicHex, otherPubkeyHex)

    // Derive shared encryption key (both parties derive same key via DH)
    const otherPk = hexToPubkey(otherPubkeyHex)
    const sharedKey = deriveSharedKey(otherPk, this.x25519Keys.secretKey)

    // Initialize conversation (their core may be added later via key exchange)
    const conversation = {
      myCore,
      theirCore: null,
      topic,
      sharedKey,
      convStore
    }
    this.conversations.set(otherPubkeyHex, conversation)

    // If we already know their core key from previous session, set it up
    const knownEntry = this.dmState.knownKeys[otherPubkeyHex]
    const knownCoreKey = (knownEntry && typeof knownEntry === 'object') ? knownEntry.coreKey : knownEntry
    if (knownCoreKey) {
      console.log(`[DM] Using known core key for ${otherPubkeyHex.slice(0, 8)}...`)
      await this._setupTheirCore(otherPubkeyHex, knownCoreKey, null)
    }

    // Replicate and announce over existing connections
    if (this.swarm.connections) {
      for (const conn of this.swarm.connections) {
        myCore.replicate(conn)

        // Set up Protomux if not already done (for pre-existing connections)
        if (!conn._dmChannel) {
          this._setupProtomux(conn)
        }

        // Announce our core key via Protomux (with small delay to ensure channel is open)
        setTimeout(() => {
          if (conn._dmKeyMessage) {
            conn._dmKeyMessage.send(this._signedAnnouncement(otherPubkeyHex, b4a.toString(myCore.key, 'hex')))
            console.log(`[DM] Announced core to peer for ${otherPubkeyHex.slice(0, 8)}...`)
          }
        }, 100)
      }
    }

    return conversation
  }

  /**
   * Send a message to another user
   * @param {string} otherPubkeyHex - Recipient's Ed25519 public key (hex)
   * @param {string} content - Message content
   * @param {Object} [media] - Optional media attachment
   * @returns {Promise<Object>} The sent message event
   */
  async sendMessage(otherPubkeyHex, content, media) {
    console.log(`[DM] Sending message to ${otherPubkeyHex.slice(0, 8)}...`)

    // Check mutual follow before sending
    if (!this.canDM(otherPubkeyHex)) {
      throw new Error('Cannot send DM - mutual follow required')
    }

    const { myCore, sharedKey } = await this.getConversation(otherPubkeyHex)

    if (!myCore.writable) {
      throw new Error('Cannot write to DM core - not writable')
    }

    // Encrypt the message using shared symmetric key
    const encrypted = encryptMessage(JSON.stringify({ content, media: media || null }), sharedKey)

    // Create the message event
    const event = {
      type: DMEventType.MESSAGE,
      from: this.identity.pubkeyHex,
      timestamp: Date.now(),
      encrypted
    }

    // Sign the encrypted payload
    const message = JSON.stringify({ encrypted: event.encrypted, timestamp: event.timestamp })
    const signature = sign(message, this.identity.secretKey)
    event.signature = b4a.toString(signature, 'hex')

    // Append to my core
    await myCore.append(event)
    console.log(`[DM] Message appended to my core, length: ${myCore.length}`)

    return event
  }

  /**
   * Get all messages in a conversation
   * @param {string} otherPubkeyHex - Other user's Ed25519 public key (hex)
   * @returns {Promise<Array>} Decrypted messages sorted by timestamp
   */
  async getMessages(otherPubkeyHex) {
    const { myCore, theirCore, sharedKey } = await this.getConversation(otherPubkeyHex)

    // Ensure cores are up to date
    await myCore.update()
    if (theirCore) {
      await theirCore.update()
    }

    console.log(`[DM] getMessages: myCore length=${myCore.length}, theirCore length=${theirCore?.length || 'none'}`)

    const messages = []

    // Read messages from my core
    for (let i = 0; i < myCore.length; i++) {
      try {
        const event = await myCore.get(i)
        if (!event || event.type !== DMEventType.MESSAGE) continue

        // My core must be signed by me
        if (event.from !== this.identity.pubkeyHex) {
          console.warn('Foreign event.from on my core, skipping')
          continue
        }

        // Verify signature
        if (!this._verifyMessageSignature(event)) {
          console.warn('Invalid signature on my message, skipping')
          continue
        }

        // Decrypt message
        const decrypted = decryptMessage(event.encrypted, sharedKey)
        if (decrypted === null) {
          console.warn('Failed to decrypt my message')
          continue
        }
        const parsed = JSON.parse(decrypted)

        messages.push({
          from: event.from,
          timestamp: event.timestamp,
          content: parsed.content,
          media: parsed.media || null,
          isMine: true
        })
      } catch (err) {
        console.warn(`Error reading my core at ${i}: ${err.message}`)
      }
    }

    // Read messages from their core (if we have it)
    if (theirCore) {
      for (let i = 0; i < theirCore.length; i++) {
        try {
          const event = await theirCore.get(i)
          if (!event || event.type !== DMEventType.MESSAGE) continue

          // Bind from-pubkey to the conversation peer so a compromised core
          // (e.g. attacker-supplied via key announcement) cannot impersonate
          // the conversation peer or third parties.
          if (event.from !== otherPubkeyHex) {
            console.warn('Unexpected event.from on their core, skipping')
            continue
          }

          // Verify signature
          if (!this._verifyMessageSignature(event)) {
            console.warn('Invalid signature on their message, skipping')
            continue
          }

          // Decrypt message
          const decrypted = decryptMessage(event.encrypted, sharedKey)
          if (decrypted === null) {
            console.warn('Failed to decrypt their message')
            continue
          }
          const parsed = JSON.parse(decrypted)

          messages.push({
            from: event.from,
            timestamp: event.timestamp,
            content: parsed.content,
            media: parsed.media || null,
            isMine: false
          })
        } catch (err) {
          console.warn(`Error reading their core at ${i}: ${err.message}`)
        }
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp)

    return messages
  }

  /**
   * Verify a message's signature
   */
  _verifyMessageSignature(event) {
    if (!event.signature || !event.from) return false

    try {
      const message = JSON.stringify({ encrypted: event.encrypted, timestamp: event.timestamp })
      const signatureBuffer = b4a.from(event.signature, 'hex')
      const publicKeyBuffer = hexToPubkey(event.from)
      return verify(message, signatureBuffer, publicKeyBuffer)
    } catch (err) {
      console.warn('Signature verification error:', err.message)
      return false
    }
  }

  /**
   * Get list of all conversations with latest message preview
   * @returns {Promise<Array>} List of conversations sorted by latest activity
   */
  async getConversationList() {
    const list = []

    for (const [otherPubkeyHex, conv] of this.conversations) {
      // Skip blocked users
      if (this.dmState.blocked.includes(otherPubkeyHex)) continue

      try {
        await conv.myCore.update()
        if (conv.theirCore) {
          await conv.theirCore.update()
        }

        let latestMessage = null
        let latestTimestamp = 0

        // Find the latest message from either core
        const checkCore = async (core) => {
          if (core && core.length > 0) {
            const event = await core.get(core.length - 1)
            if (event && event.type === DMEventType.MESSAGE && event.timestamp > latestTimestamp) {
              latestTimestamp = event.timestamp
              const content = decryptMessage(event.encrypted, conv.sharedKey)
              latestMessage = content ? content.slice(0, 50) : '[encrypted]'
            }
          }
        }

        await checkCore(conv.myCore)
        await checkCore(conv.theirCore)

        list.push({
          pubkey: otherPubkeyHex,
          latestMessage,
          latestTimestamp,
          unreadCount: await this._getUnreadCount(otherPubkeyHex)
        })
      } catch (err) {
        console.error(`Error getting conversation ${otherPubkeyHex}:`, err.message)
      }
    }

    // Sort by latest activity
    list.sort((a, b) => b.latestTimestamp - a.latestTimestamp)

    return list
  }

  /**
   * Get unread count for a conversation
   */
  async _getUnreadCount(otherPubkeyHex) {
    const conv = this.conversations.get(otherPubkeyHex)
    if (!conv || !conv.theirCore) return 0

    // If muted, always return 0
    if (this.dmState.muted.includes(otherPubkeyHex)) return 0

    const lastRead = this.dmState.lastRead[otherPubkeyHex] || 0
    let unread = 0

    await conv.theirCore.update()

    for (let i = 0; i < conv.theirCore.length; i++) {
      try {
        const event = await conv.theirCore.get(i)
        if (event &&
            event.type === DMEventType.MESSAGE &&
            event.from === otherPubkeyHex &&
            event.timestamp > lastRead) {
          unread++
        }
      } catch (err) {
        // Ignore read errors
      }
    }

    return unread
  }

  /**
   * Get total unread count across all conversations
   * @returns {Promise<number>}
   */
  async getTotalUnreadCount() {
    let total = 0
    for (const pubkey of this.conversations.keys()) {
      total += await this._getUnreadCount(pubkey)
    }
    return total
  }

  /**
   * Mark a conversation as read
   * @param {string} otherPubkeyHex
   */
  async markAsRead(otherPubkeyHex) {
    this.dmState.lastRead[otherPubkeyHex] = Date.now()
    await this._saveState()
  }

  /**
   * Block a user
   * @param {string} pubkeyHex
   */
  async blockUser(pubkeyHex) {
    if (!this.dmState.blocked.includes(pubkeyHex)) {
      this.dmState.blocked.push(pubkeyHex)
      await this._saveState()

      // Close conversation if open
      const conv = this.conversations.get(pubkeyHex)
      if (conv) {
        await this.swarm.leave(conv.topic)
        this.conversations.delete(pubkeyHex)
      }
    }
  }

  /**
   * Unblock a user
   * @param {string} pubkeyHex
   */
  async unblockUser(pubkeyHex) {
    this.dmState.blocked = this.dmState.blocked.filter(p => p !== pubkeyHex)
    await this._saveState()
  }

  /**
   * Mute a user (no notifications, but can still see messages)
   * @param {string} pubkeyHex
   */
  async muteUser(pubkeyHex) {
    if (!this.dmState.muted.includes(pubkeyHex)) {
      this.dmState.muted.push(pubkeyHex)
      await this._saveState()
    }
  }

  /**
   * Unmute a user
   * @param {string} pubkeyHex
   */
  async unmuteUser(pubkeyHex) {
    this.dmState.muted = this.dmState.muted.filter(p => p !== pubkeyHex)
    await this._saveState()
  }

  /**
   * Check if a user is blocked
   * @param {string} pubkeyHex
   * @returns {boolean}
   */
  isBlocked(pubkeyHex) {
    return this.dmState.blocked.includes(pubkeyHex)
  }

  /**
   * Check if a user is muted
   * @param {string} pubkeyHex
   * @returns {boolean}
   */
  isMuted(pubkeyHex) {
    return this.dmState.muted.includes(pubkeyHex)
  }

  /**
   * Get list of all known users (from feed's peer profiles)
   * Used for "New Message" picker
   * @param {Object} peerProfiles - { pubkey: profile } from Feed.getPeerProfiles()
   * @returns {Array} List of users that can be messaged
   */
  getMessagableUsers(peerProfiles) {
    const users = []
    for (const [pubkey, profile] of Object.entries(peerProfiles)) {
      if (pubkey === this.identity.pubkeyHex) continue // Skip self
      if (this.dmState.blocked.includes(pubkey)) continue // Skip blocked
      users.push({
        pubkey,
        name: profile.name || pubkey.slice(0, 16) + '...',
        avatar: profile.avatar
      })
    }
    return users
  }

  /**
   * Clean up - close all conversations
   */
  async close() {
    // Stop retry interval and warmup timeout
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout)
      this._retryTimeout = null
    }
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }

    // Remove connection handler
    if (this._connectionHandler) {
      this.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    for (const [pubkey, conv] of this.conversations) {
      try {
        await this.swarm.leave(conv.topic)
        await conv.myCore.close()
        if (conv.theirCore) {
          await conv.theirCore.close()
        }
      } catch (err) {
        console.error(`Error closing conversation ${pubkey}:`, err.message)
      }
    }
    this.conversations.clear()
    this.topicToConversation.clear()
    this.pendingConversations.clear()
    this.feed = null
  }
}
