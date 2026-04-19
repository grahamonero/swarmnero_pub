/**
 * Reply Notification Protocol Handler
 *
 * Enables thread visibility across the follow graph by notifying
 * OPs when non-followed users reply to their posts.
 *
 * Flow:
 * 1. Alice replies to Bob's post (Alice follows Bob, Bob doesn't follow Alice)
 * 2. Alice sends reply_notify to Bob via Protomux
 * 3. Bob receives notification:
 *    - If Bob follows Alice: auto-approve (but this case shouldn't happen - Bob would already see it)
 *    - If Bob doesn't follow Alice: show in pending approvals UI
 * 4. Bob approves: appends reply_metadata to feed, stores reply content locally
 * 5. Dave (follows Bob) sees "Alice replied" indicator, can follow Alice to see content
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { verifyEventSignature } from './feed.js'

// Protocol name
const REPLY_NOTIFY_PROTOCOL = 'swarmnero-reply-notify-v2'

// Caps to prevent a malicious peer from exhausting local state
const MAX_PENDING_APPROVALS = 500
const MAX_APPROVED_REPLIES = 1000
const MAX_REPLY_CONTENT = 50_000
const MAX_AUTHOR_NAME = 100
const MAX_AUTHOR_AVATAR = 64 * 1024

export class ReplyNotify {
  /**
   * @param {Object} options
   * @param {Object} options.feed - Feed instance
   * @param {string} options.dataDir - Data directory for persistence
   * @param {Function} options.onPendingReply - Callback when pending reply received
   */
  constructor({ feed, dataDir, onPendingReply }) {
    this.feed = feed
    this.dataDir = dataDir
    this.onPendingReply = onPendingReply || (() => {})

    this._connectionHandler = null
    this._setupConnections = new Map() // remoteKey -> conn

    // Persistent state
    this.pendingQueue = []      // Notifications we need to send
    this.pendingApprovals = []  // Notifications awaiting our approval
    this.approvedReplies = []   // Approved reply content (from non-followed users)
    this.mutedUsers = new Set() // Pubkeys we've muted
    this.sentAcks = new Set()   // IDs we've already ACKed (deduplication)

    this._loadState()
  }

  /**
   * Initialize the protocol handler
   */
  async init() {
    if (!this.feed || !this.feed.swarm) {
      throw new Error('Feed with swarm required for ReplyNotify')
    }

    // Set up connection handler
    this._connectionHandler = (conn, info) => {
      this._handleConnection(conn, info)
    }
    this.feed.swarm.on('connection', this._connectionHandler)

    // Set up on existing connections
    if (this.feed.swarm.connections) {
      for (const conn of this.feed.swarm.connections) {
        this._handleConnection(conn)
      }
    }

    // Retry interval for pending queue
    this._retryInterval = setInterval(() => {
      this._processPendingQueue()
    }, 30000) // Every 30 seconds

    console.log('[ReplyNotify] Initialized')
    return this
  }

  /**
   * Clean up
   */
  async close() {
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }

    if (this._connectionHandler && this.feed?.swarm) {
      this.feed.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }

    // Clear channel references
    for (const [key, conn] of this._setupConnections) {
      try {
        if (conn._replyNotifyChannel) {
          conn._replyNotifyChannel = null
          conn._replyNotifyMessage = null
        }
      } catch (err) {
        // Ignore cleanup errors
      }
    }
    this._setupConnections.clear()

    this._saveState()
    console.log('[ReplyNotify] Closed')
  }

  /**
   * Notify OP about a reply
   * Called when we post a reply to someone we follow but who doesn't follow us
   * @param {Object} options
   * @param {string} options.opPubkey - OP's pubkey
   * @param {string} options.opSwarmId - OP's swarm ID
   * @param {number} options.postTimestamp - Timestamp of OP's post
   * @param {Object} options.reply - Our reply event { content, media, timestamp, pubkey, signature }
   * @param {Object} options.author - Our profile { name, swarmId, avatar }
   */
  async notifyReply({ opPubkey, opSwarmId, postTimestamp, reply, author }) {
    const id = this._generateId(reply.signature)

    const notification = {
      type: 'reply_notify',
      id,
      post_timestamp: postTimestamp,
      reply: {
        content: reply.content,
        media: reply.media || [],
        timestamp: reply.timestamp,
        pubkey: reply.pubkey,
        signature: reply.signature
      },
      author: {
        name: author.name || '',
        swarmId: author.swarmId,
        avatar: author.avatar || null
      }
    }

    // Try to send immediately if connected
    const conn = this._getConnectionForSwarmId(opSwarmId)
    if (conn && conn._replyNotifyMessage) {
      try {
        conn._replyNotifyMessage.send(notification)
        console.log(`[ReplyNotify] Sent notification to ${opSwarmId.slice(0, 16)}...`)

        // Add to pending queue to track ACK
        this._addToPendingQueue({
          ...notification,
          targetSwarmId: opSwarmId,
          queuedAt: Date.now(),
          sent: true
        })
        return true
      } catch (err) {
        console.warn('[ReplyNotify] Error sending:', err.message)
      }
    }

    // Queue for later if not connected
    console.log(`[ReplyNotify] Queuing notification for ${opSwarmId.slice(0, 16)}...`)
    this._addToPendingQueue({
      ...notification,
      targetSwarmId: opSwarmId,
      queuedAt: Date.now(),
      sent: false
    })

    return false
  }

  /**
   * Approve a pending reply
   * @param {string} id - Notification ID
   * @returns {Object|null} The approved reply or null if not found
   */
  async approveReply(id) {
    const index = this.pendingApprovals.findIndex(p => p.id === id)
    if (index === -1) {
      console.warn('[ReplyNotify] Pending reply not found:', id)
      return null
    }

    const pending = this.pendingApprovals[index]

    // Remove from pending
    this.pendingApprovals.splice(index, 1)

    // Store approved reply content locally
    this.approvedReplies.push({
      postTimestamp: pending.post_timestamp,
      reply: pending.reply,
      author: pending.author,
      approvedAt: Date.now()
    })

    // Send ACK
    this._sendAck(pending.id, 'accepted', pending._fromSwarmId)

    this._saveState()

    console.log(`[ReplyNotify] Approved reply from ${pending.author.name || pending.reply.pubkey.slice(0, 16)}`)

    return {
      postTimestamp: pending.post_timestamp,
      replier: {
        pubkey: pending.reply.pubkey,
        swarmId: pending.author.swarmId,
        name: pending.author.name,
        replyTimestamp: pending.reply.timestamp
      }
    }
  }

  /**
   * Ignore a pending reply (don't show, but allow future notifications)
   * @param {string} id - Notification ID
   */
  ignoreReply(id) {
    const index = this.pendingApprovals.findIndex(p => p.id === id)
    if (index === -1) return

    const pending = this.pendingApprovals[index]
    this.pendingApprovals.splice(index, 1)

    this._sendAck(pending.id, 'ignored', pending._fromSwarmId)
    this._saveState()

    console.log(`[ReplyNotify] Ignored reply from ${pending.author.name || pending.reply.pubkey.slice(0, 16)}`)
  }

  /**
   * Mute a user (block future notifications)
   * @param {string} pubkey - User's pubkey to mute
   */
  muteUser(pubkey) {
    this.mutedUsers.add(pubkey)

    // Remove any pending from this user
    const pending = this.pendingApprovals.filter(p => p.reply.pubkey === pubkey)
    for (const p of pending) {
      this._sendAck(p.id, 'muted', p._fromSwarmId)
    }
    this.pendingApprovals = this.pendingApprovals.filter(p => p.reply.pubkey !== pubkey)

    this._saveState()
    console.log(`[ReplyNotify] Muted user ${pubkey.slice(0, 16)}...`)
  }

  /**
   * Unmute a user
   * @param {string} pubkey - User's pubkey to unmute
   */
  unmuteUser(pubkey) {
    this.mutedUsers.delete(pubkey)
    this._saveState()
    console.log(`[ReplyNotify] Unmuted user ${pubkey.slice(0, 16)}...`)
  }

  /**
   * Check if a user is muted
   * @param {string} pubkey - User's pubkey
   * @returns {boolean}
   */
  isMuted(pubkey) {
    return this.mutedUsers.has(pubkey)
  }

  /**
   * Get pending approvals
   * @returns {Array}
   */
  getPendingApprovals() {
    return [...this.pendingApprovals]
  }

  /**
   * Get approved replies for a specific post
   * @param {number} postTimestamp - The post's timestamp
   * @returns {Array}
   */
  getApprovedRepliesForPost(postTimestamp) {
    return this.approvedReplies.filter(r => r.postTimestamp === postTimestamp)
  }

  /**
   * Get all approved replies
   * @returns {Array}
   */
  getAllApprovedReplies() {
    return [...this.approvedReplies]
  }

  /**
   * Get muted users
   * @returns {Array}
   */
  getMutedUsers() {
    return Array.from(this.mutedUsers)
  }

  // --- Private Methods ---

  _generateId(signature) {
    // Use first 16 chars of signature hash as ID
    return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 32)
  }

  _handleConnection(conn, info) {
    // Skip infrastructure connections (e.g. sync server) - they don't speak ReplyNotify
    if (conn._isInfrastructure) return

    // Track connection by remote public key
    const remoteKey = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : null
    if (!remoteKey) return

    conn.once('close', () => {
      this._setupConnections.delete(remoteKey)
    })

    this._setupProtomux(conn, remoteKey)
  }

  _setupProtomux(conn, remoteKey) {
    if (conn._isInfrastructure) return

    if (conn._replyNotifyChannel && !conn._replyNotifyChannel.closed) {
      return
    }

    if (conn._replyNotifyPaired) {
      return
    }

    try {
      const mux = Protomux.from(conn)
      if (mux.destroyed) return

      conn._replyNotifyPaired = true

      // Listen for remote peer
      mux.pair({ protocol: REPLY_NOTIFY_PROTOCOL }, () => {
        this._createChannel(mux, conn, remoteKey)
      })

      // Also initiate
      this._createChannel(mux, conn, remoteKey)

    } catch (err) {
      console.error('[ReplyNotify] Error setting up Protomux:', err.message)
    }
  }

  _createChannel(mux, conn, remoteKey) {
    if (conn._replyNotifyChannel && !conn._replyNotifyChannel.closed) {
      return
    }

    const channel = mux.createChannel({
      protocol: REPLY_NOTIFY_PROTOCOL,
      unique: true,
      onopen: () => {
        console.log('[ReplyNotify] Channel opened with peer')
        this._setupConnections.set(remoteKey, conn)

        // Process pending queue for this peer
        setTimeout(() => this._processPendingQueueForPeer(remoteKey), 500)
      },
      onclose: () => {
        conn._replyNotifyChannel = null
        conn._replyNotifyMessage = null
        this._setupConnections.delete(remoteKey)
      }
    })

    if (!channel) return

    const message = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => this._handleMessage(msg, conn, remoteKey)
    })

    conn._replyNotifyChannel = channel
    conn._replyNotifyMessage = message

    channel.open()
  }

  _handleMessage(msg, conn, remoteKey) {
    if (msg.type === 'reply_notify') {
      this._handleReplyNotify(msg, conn, remoteKey)
    } else if (msg.type === 'reply_ack') {
      this._handleReplyAck(msg)
    }
  }

  _handleReplyNotify(msg, conn, remoteKey) {
    const { id, post_timestamp, reply, author } = msg

    // Shape + size validation before doing any work. A peer could otherwise
    // flood us with oversized strings that each trigger a sync disk write.
    if (typeof id !== 'string' || id.length > 128) return
    if (typeof post_timestamp !== 'number' || !Number.isFinite(post_timestamp)) return
    if (!reply || typeof reply !== 'object') return
    if (typeof reply.pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(reply.pubkey)) return
    if (typeof reply.signature !== 'string' || !/^[a-f0-9]{128}$/i.test(reply.signature)) return
    if (typeof reply.content !== 'string' || reply.content.length > MAX_REPLY_CONTENT) return
    if (typeof reply.timestamp !== 'number') return
    if (!author || typeof author !== 'object') return
    if (author.name && (typeof author.name !== 'string' || author.name.length > MAX_AUTHOR_NAME)) return
    if (author.avatar && (typeof author.avatar !== 'string' || author.avatar.length > MAX_AUTHOR_AVATAR)) return
    if (author.swarmId && (typeof author.swarmId !== 'string' || !/^[a-f0-9]{64}$/i.test(author.swarmId))) return

    // Verify the reply event signature. Without this an attacker could claim
    // any pubkey authored any content and, if they guess a swarmId we follow,
    // the auto-approve branch below will silently graft it into our timeline.
    if (!verifyEventSignature({
      type: 'reply',
      pubkey: reply.pubkey,
      timestamp: reply.timestamp,
      signature: reply.signature,
      content: reply.content,
      media: reply.media || [],
      to_pubkey: msg.to_pubkey,
      post_timestamp
    })) {
      console.warn('[ReplyNotify] Rejected reply with invalid signature from', reply.pubkey.slice(0, 8))
      return
    }

    // Check if muted
    if (this.mutedUsers.has(reply.pubkey)) {
      console.log(`[ReplyNotify] Ignoring notification from muted user ${reply.pubkey.slice(0, 16)}`)
      this._sendAck(id, 'muted', remoteKey)
      return
    }

    // Check if already processed (deduplication)
    if (this.sentAcks.has(id)) {
      console.log('[ReplyNotify] Duplicate notification, re-sending ACK')
      this._sendAck(id, 'accepted', remoteKey)
      return
    }

    // Check if we already have this in pending or approved
    const inPending = this.pendingApprovals.some(p => p.id === id)
    const inApproved = this.approvedReplies.some(r => r.reply.signature === reply.signature)

    if (inPending || inApproved) {
      console.log('[ReplyNotify] Already have this reply')
      this._sendAck(id, 'accepted', remoteKey)
      return
    }

    // Cap approved history growth (drop oldest)
    while (this.approvedReplies.length >= MAX_APPROVED_REPLIES) {
      this.approvedReplies.shift()
    }

    // Check if we follow the replier (auto-approve)
    // Note: If we follow them, we'd normally see their reply anyway
    // But this handles edge cases like delayed sync
    const replierSwarmId = author.swarmId
    if (replierSwarmId && this.feed.peers.has(replierSwarmId)) {
      console.log(`[ReplyNotify] Auto-approving reply from followed user ${author.name || reply.pubkey.slice(0, 16)}`)

      // Still store it in approved for redundancy
      this.approvedReplies.push({
        postTimestamp: post_timestamp,
        reply,
        author,
        approvedAt: Date.now()
      })

      this._sendAck(id, 'accepted', remoteKey)
      this._saveState()

      // Notify UI
      if (this.onPendingReply) {
        this.onPendingReply({ autoApproved: true, author, postTimestamp: post_timestamp })
      }
      return
    }

    // Cap pending-approval growth (drop oldest)
    while (this.pendingApprovals.length >= MAX_PENDING_APPROVALS) {
      this.pendingApprovals.shift()
    }

    // Add to pending approvals
    console.log(`[ReplyNotify] New pending reply from ${author.name || reply.pubkey.slice(0, 16)}`)

    this.pendingApprovals.push({
      id,
      post_timestamp,
      reply,
      author,
      receivedAt: Date.now(),
      _fromSwarmId: remoteKey
    })

    this._saveState()

    // Notify UI
    if (this.onPendingReply) {
      this.onPendingReply({ pending: true, author, postTimestamp: post_timestamp })
    }
  }

  _handleReplyAck(msg) {
    const { id, status } = msg

    // Find in pending queue and remove
    const index = this.pendingQueue.findIndex(p => p.id === id)
    if (index !== -1) {
      const item = this.pendingQueue[index]
      this.pendingQueue.splice(index, 1)
      this._saveState()

      console.log(`[ReplyNotify] Received ACK (${status}) for notification to ${item.targetSwarmId?.slice(0, 16)}`)
    }
  }

  _sendAck(id, status, targetRemoteKey) {
    this.sentAcks.add(id)

    // Find connection
    const conn = this._setupConnections.get(targetRemoteKey)
    if (!conn || !conn._replyNotifyMessage) {
      console.warn('[ReplyNotify] Cannot send ACK - no connection')
      return
    }

    try {
      conn._replyNotifyMessage.send({
        type: 'reply_ack',
        id,
        status
      })
    } catch (err) {
      console.warn('[ReplyNotify] Error sending ACK:', err.message)
    }
  }

  _addToPendingQueue(item) {
    // Check for duplicate
    if (this.pendingQueue.some(p => p.id === item.id)) {
      return
    }

    this.pendingQueue.push(item)
    this._saveState()
  }

  _processPendingQueue() {
    // Clean old items (> 7 days)
    const maxAge = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    this.pendingQueue = this.pendingQueue.filter(p => now - p.queuedAt < maxAge)

    // Try to send unsent items
    for (const item of this.pendingQueue) {
      if (!item.sent) {
        const conn = this._getConnectionForSwarmId(item.targetSwarmId)
        if (conn && conn._replyNotifyMessage) {
          try {
            conn._replyNotifyMessage.send({
              type: 'reply_notify',
              id: item.id,
              post_timestamp: item.post_timestamp,
              reply: item.reply,
              author: item.author
            })
            item.sent = true
            console.log(`[ReplyNotify] Sent queued notification to ${item.targetSwarmId.slice(0, 16)}...`)
          } catch (err) {
            console.warn('[ReplyNotify] Error sending queued notification:', err.message)
          }
        }
      }
    }

    this._saveState()
  }

  _processPendingQueueForPeer(remoteKey) {
    // Find items targeting this peer and try to send
    for (const item of this.pendingQueue) {
      if (!item.sent && item.targetSwarmId) {
        // Check if this remote key matches the target
        // We need to map swarmId to remoteKey somehow
        // For now, try all connections
        const conn = this._setupConnections.get(remoteKey)
        if (conn && conn._replyNotifyMessage) {
          try {
            conn._replyNotifyMessage.send({
              type: 'reply_notify',
              id: item.id,
              post_timestamp: item.post_timestamp,
              reply: item.reply,
              author: item.author
            })
            item.sent = true
            console.log(`[ReplyNotify] Sent queued notification on new connection`)
          } catch (err) {
            // Ignore
          }
        }
      }
    }
    this._saveState()
  }

  _getConnectionForSwarmId(swarmId) {
    // Find the connection that actually replicates the target swarmId's core.
    // This avoids sending reply content (which may be sensitive) to arbitrary
    // peers — the previous implementation returned the first available conn,
    // which leaked private reply text to unrelated peers.
    if (!swarmId || typeof swarmId !== 'string') return null
    try {
      const peerCore = this.feed?.peers?.get(swarmId)
      if (!peerCore) return null
      const peers = peerCore.peers || []
      for (const p of peers) {
        const stream = p?.stream?.rawStream || p?.protomux?.stream || null
        if (!stream) continue
        for (const [, conn] of this._setupConnections) {
          if (conn === stream || conn?.rawStream === stream || conn?.stream === stream) {
            if (conn._replyNotifyMessage && !conn.destroyed) return conn
          }
        }
      }
    } catch (err) {
      // fall through
    }
    return null
  }

  // --- Persistence ---

  _getStatePath() {
    const pubkey = this.feed?.identity?.pubkeyHex || 'unknown'
    return path.join(this.dataDir, `reply-notify-${pubkey}.json`)
  }

  _loadState() {
    try {
      const statePath = this._getStatePath()
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf8'))
        this.pendingQueue = data.pendingQueue || []
        this.pendingApprovals = data.pendingApprovals || []
        this.approvedReplies = data.approvedReplies || []
        this.mutedUsers = new Set(data.mutedUsers || [])
        this.sentAcks = new Set(data.sentAcks || [])

        console.log(`[ReplyNotify] Loaded state: ${this.pendingApprovals.length} pending, ${this.approvedReplies.length} approved, ${this.mutedUsers.size} muted`)
      }
    } catch (err) {
      console.warn('[ReplyNotify] Error loading state:', err.message)
    }
  }

  _saveState() {
    try {
      const statePath = this._getStatePath()
      const data = {
        pendingQueue: this.pendingQueue,
        pendingApprovals: this.pendingApprovals,
        approvedReplies: this.approvedReplies,
        mutedUsers: Array.from(this.mutedUsers),
        sentAcks: Array.from(this.sentAcks).slice(-1000) // Keep last 1000 for dedup
      }
      fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.warn('[ReplyNotify] Error saving state:', err.message)
    }
  }
}
