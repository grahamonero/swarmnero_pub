/**
 * Sync Protocol - Protomux handler for sync service registration
 *
 * Authentication: nonce-challenge per channel.
 *   1. Server generates 32-byte nonce on channel open → sends auth_challenge
 *   2. Client signs (nonce || 'auth_hello' || pubkey) with Ed25519 → sends auth_hello
 *   3. Server verifies signature, binds verified pubkey to connection
 *   4. All subsequent messages: msg.pubkey must equal connection's verified pubkey
 *
 * Payment: real on-chain verification only.
 *   - sync_register → server quotes $12 in XMR at current price, stores requiredAtomic
 *   - sync_payment_proof → server calls check_tx_key, enforces received >= requiredAtomic
 *     and that txHash hasn't been consumed by another account
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import sodium from 'sodium-native'

import { verify } from './identity.js'

const SYNC_PROTOCOL = 'swarmnero-sync-v1'

// Rate limiting: 1 request per 10 seconds per peer per msg type
const RATE_LIMIT_MS = 10000

// Global sliding window: at most this many sync_register attempts per minute
// across all peers. Guards against distributed flooding even when per-IP limits
// are respected. 100/min = one new supporter every 0.6s sustained — plenty.
const GLOBAL_REGISTER_LIMIT = 100
const GLOBAL_WINDOW_MS = 60 * 1000

// How often to garbage-collect the _requestTimes map to avoid unbounded growth
const RATE_GC_INTERVAL_MS = 10 * 60 * 1000
const RATE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000

// USD equivalent of the supporter subscription fee (informational — server
// verifies received amount against this minimum with tolerance)
const SUPPORTER_USD = 12

// Minimum atomic XMR received for a tx to count as a supporter payment.
// 0.025 XMR is ~$8-10 depending on price; loose enough to tolerate price
// drift between when the user paid and now.
const MIN_SUPPORTER_ATOMIC = 25_000_000_000n

export class SyncProtocol {
  constructor({ syncFeed, syncManager, syncWallet, priceOracle, consumedTxs, identity }) {
    this.syncFeed = syncFeed
    this.syncManager = syncManager
    this.syncWallet = syncWallet
    this.priceOracle = priceOracle
    this.consumedTxs = consumedTxs
    this.identity = identity
    this._setupConnections = new Set()
    this._requestTimes = new Map()
    this._globalRegisterTimes = []
    // Serial mutex for subaddress allocation — prevents races between
    // syncManager.registerAccount and syncWallet.getSubaddress that could
    // desync the DB's index map from the wallet's actual address ordering.
    this._allocChain = Promise.resolve()
  }

  /**
   * Send `msg` signed with the server's Ed25519 identity key. The signature
   * is computed over JSON.stringify(msg) BEFORE the `sig` field is added,
   * so the client reverses by deleting sig and re-stringifying.
   *
   * Key ordering is stable across V8 for string keys (insertion order),
   * so server and client JSON.stringify produce identical bytes.
   */
  _sendSigned(conn, msg) {
    if (!conn?._syncMessage) return
    if (!this.identity) {
      console.error('[SyncProtocol] No identity — cannot sign response')
      return
    }
    const body = { ...msg }
    delete body.sig
    const payload = JSON.stringify(body)
    const sig = this.identity.sign(payload)
    conn._syncMessage.send({ ...body, sig: b4a.toString(sig, 'hex') })
  }

  init() {
    this._connectionHandler = (conn) => {
      this._setupProtomux(conn)
    }
    this.syncFeed.swarm.on('connection', this._connectionHandler)

    if (this.syncFeed.swarm?.connections) {
      for (const conn of this.syncFeed.swarm.connections) {
        if (!conn.destroyed) this._setupProtomux(conn)
      }
    }

    this._retryInterval = setInterval(() => {
      this._retryAllConnections()
    }, 10000)

    // Periodic cleanup of rate-limit state so long-running server doesn't
    // accumulate stale entries from peers that never return
    this._gcInterval = setInterval(() => {
      this._gcRateState()
    }, RATE_GC_INTERVAL_MS)

    console.log('[SyncProtocol] Initialized')
  }

  /**
   * Drop rate-limit entries older than RATE_ENTRY_MAX_AGE_MS
   */
  _gcRateState() {
    const cutoff = Date.now() - RATE_ENTRY_MAX_AGE_MS
    for (const [key, ts] of this._requestTimes) {
      if (ts < cutoff) this._requestTimes.delete(key)
    }
    this._globalRegisterTimes = this._globalRegisterTimes.filter(t => t >= cutoff)
  }

  /**
   * Check rate limits for a message. Returns null if allowed, or a reason
   * string if rate-limited. Records the request time on success.
   *
   * Limits:
   *  - 1 per 10s per (Noise peerId, msgType) — existing per-peer limit
   *  - For sync_register only: 1 per 10s per (remoteHost, 'sync_register')
   *    — same IP can't bypass by rotating Noise keys
   *  - For sync_register only: 100 per minute globally — sliding window
   */
  _checkRateLimit(conn, msgType) {
    if (msgType === 'auth_hello') return null  // exempt — one per channel

    const now = Date.now()
    const peerId = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : 'unknown'
    const perPeerKey = `peer:${peerId}:${msgType}`
    const peerLast = this._requestTimes.get(perPeerKey)
    if (peerLast && (now - peerLast) < RATE_LIMIT_MS) {
      return `per-peer rate limit (${msgType})`
    }

    if (msgType === 'sync_register') {
      const remoteHost = conn.rawStream?.remoteHost
      if (remoteHost) {
        const perHostKey = `host:${remoteHost}:sync_register`
        const hostLast = this._requestTimes.get(perHostKey)
        if (hostLast && (now - hostLast) < RATE_LIMIT_MS) {
          return `per-IP rate limit (sync_register)`
        }
        this._requestTimes.set(perHostKey, now)
      }

      // Global sliding window — 100 register attempts per minute
      const windowStart = now - GLOBAL_WINDOW_MS
      this._globalRegisterTimes = this._globalRegisterTimes.filter(t => t >= windowStart)
      if (this._globalRegisterTimes.length >= GLOBAL_REGISTER_LIMIT) {
        return `global sync_register rate limit`
      }
      this._globalRegisterTimes.push(now)
    }

    this._requestTimes.set(perPeerKey, now)
    return null
  }

  /**
   * Run `fn` serialized against all other allocation operations.
   * Ensures syncManager.registerAccount + syncWallet.getSubaddress pairs
   * execute strictly one-at-a-time so the DB index and wallet subaddress
   * allocation order cannot diverge.
   */
  _withAllocMutex(fn) {
    const run = this._allocChain.then(fn, fn)
    // Advance chain past this operation's outcome (ignoring errors so one
    // failure doesn't poison all subsequent allocations)
    this._allocChain = run.catch(() => {})
    return run
  }

  _setupProtomux(conn) {
    if (conn._syncChannel && !conn._syncChannel.closed) return
    if (conn._syncPaired) return

    try {
      const mux = Protomux.from(conn)
      if (mux.destroyed) return

      conn._syncPaired = true

      mux.pair({ protocol: SYNC_PROTOCOL }, () => {
        this._createChannel(mux, conn)
      })

      this._createChannel(mux, conn)
    } catch (err) {
      console.error('[SyncProtocol] Error setting up Protomux:', err.message)
    }
  }

  _createChannel(mux, conn) {
    if (conn._syncChannel && !conn._syncChannel.closed) return

    const channel = mux.createChannel({
      protocol: SYNC_PROTOCOL,
      unique: false,
      onopen: () => {
        this._issueChallenge(conn)
      },
      onclose: () => {
        conn._syncChannel = null
        conn._syncMessage = null
        conn._syncNonce = null
        conn._syncVerifiedPubkey = null
      }
    })

    if (!channel) return

    const message = channel.addMessage({
      encoding: c.json,
      onmessage: (msg) => {
        this._handleMessage(msg, conn)
      }
    })

    conn._syncChannel = channel
    conn._syncMessage = message
    this._setupConnections.add(conn)

    channel.open()
  }

  /**
   * Generate a fresh nonce for this channel and send auth_challenge
   */
  _issueChallenge(conn) {
    const nonce = b4a.alloc(32)
    sodium.randombytes_buf(nonce)
    conn._syncNonce = nonce
    conn._syncVerifiedPubkey = null
    this._sendSigned(conn, {
      type: 'auth_challenge',
      nonce: b4a.toString(nonce, 'hex')
    })
    console.log('[SyncProtocol] Issued auth challenge on channel open')
  }

  async _handleMessage(msg, conn) {
    const limitReason = this._checkRateLimit(conn, msg.type)
    if (limitReason) {
      const peerId = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : 'unknown'
      console.warn(`[SyncProtocol] Rate limited ${msg.type} from ${peerId.slice(0, 8)}: ${limitReason}`)
      return
    }

    // auth_hello must be the first message after channel open
    if (msg.type === 'auth_hello') {
      await this._handleAuthHello(msg, conn)
      return
    }

    // All other message types require prior auth and must match the bound pubkey
    if (!conn._syncVerifiedPubkey) {
      this._sendError(conn, 'Not authenticated — send auth_hello first')
      return
    }
    if (msg.pubkey !== conn._syncVerifiedPubkey) {
      console.warn(`[SyncProtocol] pubkey mismatch on ${msg.type}: bound=${conn._syncVerifiedPubkey?.slice(0, 8)} claimed=${msg.pubkey?.slice(0, 8)}`)
      this._sendError(conn, 'pubkey does not match authenticated identity')
      return
    }

    console.log('[SyncProtocol] Received:', msg.type, 'from', msg.pubkey?.slice(0, 8))

    switch (msg.type) {
      case 'sync_enable':
        await this._handleSyncEnable(msg, conn)
        break
      case 'sync_disable':
        await this._handleSyncDisable(msg, conn)
        break
      case 'sync_register':
        await this._handleRegister(msg, conn)
        break
      case 'sync_payment_proof':
        await this._handlePaymentProof(msg, conn)
        break
      case 'sync_status_request':
        await this._handleStatusRequest(msg, conn)
        break
      default:
        console.warn('[SyncProtocol] Unknown message type:', msg.type)
    }
  }

  /**
   * Verify auth_hello and bind the verified pubkey to this connection.
   * Payload signed: nonce || 'auth_hello' || pubkey  (all as raw bytes)
   */
  async _handleAuthHello(msg, conn) {
    const { pubkey, sig } = msg
    if (!pubkey || !sig) {
      this._sendError(conn, 'auth_hello missing pubkey or sig')
      return
    }
    if (!conn._syncNonce) {
      this._sendError(conn, 'no pending challenge for this channel')
      return
    }

    let pubkeyBuf, sigBuf
    try {
      pubkeyBuf = b4a.from(pubkey, 'hex')
      sigBuf = b4a.from(sig, 'hex')
    } catch {
      this._sendError(conn, 'auth_hello has invalid hex encoding')
      return
    }

    if (pubkeyBuf.length !== 32 || sigBuf.length !== 64) {
      this._sendError(conn, 'auth_hello has wrong key/sig length')
      return
    }

    const signedPayload = b4a.concat([
      conn._syncNonce,
      b4a.from('auth_hello'),
      pubkeyBuf
    ])

    let ok = false
    try {
      ok = verify(signedPayload, sigBuf, pubkeyBuf)
    } catch (err) {
      console.error('[SyncProtocol] Verify threw:', err.message)
    }

    if (!ok) {
      this._sendError(conn, 'signature verification failed')
      return
    }

    conn._syncVerifiedPubkey = pubkey
    this._sendSigned(conn, { type: 'auth_ok' })
    console.log(`[SyncProtocol] Authenticated ${pubkey.slice(0, 16)}...`)
  }

  /**
   * Enable feed backup using the user's supporter-listing payment as proof.
   *
   * No separate charge. The supporter fee ($12/yr, already paid to the
   * primary wallet via the listing flow) covers backup. We verify:
   *   - tx was paid to the primary wallet
   *   - received amount >= MIN_SUPPORTER_ATOMIC (sanity check)
   *   - tx hasn't been consumed to activate a different account
   * Then activate with a 1-year expiry.
   */
  async _handleSyncEnable(msg, conn) {
    const { pubkey, swarmId, txHash, txKey } = msg
    if (!pubkey || !swarmId || !txHash || !txKey) {
      this._sendError(conn, 'Missing pubkey, swarmId, txHash, or txKey')
      return
    }

    if (!this.syncWallet?.ready) {
      this._sendError(conn, 'Server wallet unavailable — try again later')
      return
    }

    try {
      const existing = this.syncManager.getAccount(pubkey)

      // Idempotent: already active and within subscription
      if (existing?.active && existing.expiresAt > Date.now()) {
        const status = this.syncManager.getStatus(pubkey)
        const syncStats = this.syncFeed.getSyncStats(existing.swarmId)
        this._sendSigned(conn, {
          type: 'sync_status',
          ...status,
          ...syncStats
        })
        return
      }

      // Re-enable within valid subscription window — no new payment needed.
      // User previously disabled, now toggling back on before expiry.
      if (existing && existing.expiresAt && existing.expiresAt > Date.now()) {
        this.syncManager.reactivateAccount(pubkey)
        await this.syncFeed.follow(existing.swarmId)
        const status = this.syncManager.getStatus(pubkey)
        const syncStats = this.syncFeed.getSyncStats(existing.swarmId)
        this._sendSigned(conn, {
          type: 'sync_status',
          ...status,
          ...syncStats
        })
        console.log(`[SyncProtocol] Re-enabled backup for ${pubkey.slice(0, 8)}... (within subscription)`)
        return
      }

      if (this.consumedTxs.has(txHash)) {
        this._sendError(conn, 'This supporter payment has already been used to activate backup on another account')
        return
      }

      const primaryAddress = await this.syncWallet.getAddress()
      const result = await this.syncWallet.verifyPayment(txHash, txKey, primaryAddress)
      if (!result.verified) {
        this._sendError(conn, 'Payment verification failed — tx not found or wrong destination')
        return
      }

      const receivedAtomic = BigInt(result.amount)
      if (receivedAtomic < MIN_SUPPORTER_ATOMIC) {
        console.warn(`[SyncProtocol] sync_enable short payment: received=${receivedAtomic}`)
        this._sendError(conn, `Supporter payment too small — need at least 0.025 XMR, got ${(Number(receivedAtomic) / 1e12).toFixed(6)} XMR`)
        return
      }

      await this._withAllocMutex(async () => {
        this.syncManager.registerAccount(pubkey, swarmId)
      })

      this.consumedTxs.add(txHash)
      this.syncManager.activateAccount(pubkey, txHash, receivedAtomic.toString())
      await this.syncFeed.follow(swarmId)

      const status = this.syncManager.getStatus(pubkey)
      const syncStats = this.syncFeed.getSyncStats(swarmId)
      this._sendSigned(conn, {
        type: 'sync_status',
        ...status,
        ...syncStats
      })
      console.log(`[SyncProtocol] Enabled backup for ${pubkey.slice(0, 8)}... via supporter tx ${txHash.slice(0, 8)}`)
    } catch (err) {
      console.error(`[SyncProtocol] sync_enable error for ${pubkey?.slice(0, 8)}:`, err.message)
      this._sendError(conn, 'Backup activation error: ' + err.message)
    }
  }

  /**
   * Disable feed backup for the account. Keeps the account record and
   * expiresAt so the user can re-enable for free within their subscription
   * period without a new payment. Server stops replicating their feed.
   */
  async _handleSyncDisable(msg, conn) {
    const { pubkey } = msg
    if (!pubkey) {
      this._sendError(conn, 'Missing pubkey')
      return
    }

    const account = this.syncManager.getAccount(pubkey)
    if (!account) {
      this._sendError(conn, 'No account to disable')
      return
    }

    this.syncManager.deactivateAccount(pubkey)
    if (account.swarmId) {
      try {
        await this.syncFeed.unfollow(account.swarmId)
      } catch (err) {
        console.warn(`[SyncProtocol] Unfollow on disable failed for ${pubkey.slice(0, 8)}:`, err.message)
      }
    }

    const status = this.syncManager.getStatus(pubkey)
    this._sendSigned(conn, {
      type: 'sync_status',
      ...status
    })
    console.log(`[SyncProtocol] Disabled backup for ${pubkey.slice(0, 8)}...`)
  }

  /**
   * Handle registration — generate subaddress and price quote.
   * Subaddress allocation runs through the mutex so concurrent registers
   * can't desync DB index assignments from the wallet's subaddress order.
   */
  async _handleRegister(msg, conn) {
    const { pubkey, swarmId } = msg
    if (!pubkey || !swarmId) {
      this._sendError(conn, 'Missing pubkey or swarmId')
      return
    }

    try {
      // Price oracle reads are idempotent and safe to run outside the mutex
      let xmrUsd, requiredAtomic
      try {
        xmrUsd = await this.priceOracle.getUsdPrice()
        requiredAtomic = await this.priceOracle.atomicForUsd(SUPPORTER_USD)
      } catch (err) {
        console.error('[SyncProtocol] Price oracle failed:', err.message)
        this._sendError(conn, 'Price oracle unavailable — try again later')
        return
      }

      // Serialize the actual allocation: registerAccount, getSubaddress,
      // setSubaddress, setQuote must all happen before any other register
      // can touch the index counter or the wallet subaddress table.
      const result = await this._withAllocMutex(async () => {
        const subaddressIndex = this.syncManager.registerAccount(pubkey, swarmId)

        const existing = this.syncManager.getAccount(pubkey)
        if (existing?.active) {
          return {
            alreadyActive: true,
            subaddress: existing.subaddress,
            subaddressIndex: existing.subaddressIndex,
            status: this.syncManager.getStatus(pubkey)
          }
        }

        let subaddress = existing?.subaddress || null
        if (!subaddress && this.syncWallet) {
          subaddress = await this.syncWallet.getSubaddress(subaddressIndex)
          this.syncManager.setSubaddress(pubkey, subaddress)
        }

        this.syncManager.setQuote(pubkey, {
          requiredAtomic,
          quotedUsd: SUPPORTER_USD
        })

        const account = this.syncManager.getAccount(pubkey)
        return {
          alreadyActive: false,
          subaddress,
          subaddressIndex,
          quoteExpiresAt: account.quoteExpiresAt
        }
      })

      if (!conn._syncMessage) return

      if (result.alreadyActive) {
        this._sendSigned(conn, {
          type: 'sync_subaddress',
          subaddress: result.subaddress,
          subaddressIndex: result.subaddressIndex,
          alreadyActive: true,
          ...result.status
        })
        return
      }

      this._sendSigned(conn, {
        type: 'sync_subaddress',
        subaddress: result.subaddress,
        subaddressIndex: result.subaddressIndex,
        requiredAtomic: requiredAtomic.toString(),
        quotedUsd: SUPPORTER_USD,
        quoteExpiresAt: result.quoteExpiresAt,
        xmrUsdPrice: xmrUsd
      })
      console.log(`[SyncProtocol] Quoted ${pubkey.slice(0, 8)}... ${requiredAtomic} atomic @ $${xmrUsd}/XMR`)
    } catch (err) {
      console.error(`[SyncProtocol] Register error for ${pubkey.slice(0, 8)}:`, err.message)
      this._sendError(conn, 'Registration failed: ' + err.message)
    }
  }

  /**
   * Handle payment proof — verify on-chain, enforce amount + consumed-tx set.
   * No trust path.
   */
  async _handlePaymentProof(msg, conn) {
    const { pubkey, txHash, txKey } = msg
    if (!pubkey || !txHash || !txKey) {
      this._sendError(conn, 'Missing pubkey, txHash, or txKey')
      return
    }

    if (!this.syncWallet?.ready) {
      this._sendError(conn, 'Server wallet unavailable — try again later')
      return
    }

    try {
      const account = this.syncManager.getAccount(pubkey)
      if (!account) {
        this._sendError(conn, 'Account not registered. Send sync_register first.')
        return
      }

      if (!account.subaddress) {
        this._sendError(conn, 'No subaddress allocated for this account')
        return
      }

      // Replay check: tx may only activate one account
      if (this.consumedTxs.has(txHash)) {
        console.warn(`[SyncProtocol] Replay attempt: ${txHash} already consumed`)
        this._sendError(conn, 'This transaction has already been used for another account')
        return
      }

      // Verify destination + amount via Monero RPC
      const result = await this.syncWallet.verifyPayment(txHash, txKey, account.subaddress)
      if (!result.verified) {
        this._sendError(conn, 'Payment verification failed — tx not found or wrong destination')
        return
      }

      // Enforce amount against the stored quote
      const receivedAtomic = BigInt(result.amount)
      if (!this.syncManager.isPaymentSufficient(pubkey, receivedAtomic)) {
        const required = this.syncManager.getRequiredAtomic(pubkey)
        console.warn(`[SyncProtocol] Short payment: received=${receivedAtomic} required=${required}`)
        this._sendError(conn, `Payment amount insufficient — received ${receivedAtomic}, need ${required ?? 'quote missing'}`)
        return
      }

      // Activate and lock the tx hash so it can't be replayed
      this.consumedTxs.add(txHash)
      this.syncManager.activateAccount(pubkey, txHash, receivedAtomic.toString())
      await this.syncFeed.follow(account.swarmId)

      const status = this.syncManager.getStatus(pubkey)
      const syncStats = this.syncFeed.getSyncStats(account.swarmId)
      this._sendSigned(conn, {
        type: 'sync_status',
        ...status,
        ...syncStats
      })
      console.log(`[SyncProtocol] Activated ${pubkey.slice(0, 8)}... tx=${txHash.slice(0, 8)}`)
    } catch (err) {
      console.error(`[SyncProtocol] Payment proof error for ${pubkey?.slice(0, 8)}:`, err.message)
      this._sendError(conn, 'Payment verification error: ' + err.message)
    }
  }

  async _handleStatusRequest(msg, conn) {
    const { pubkey } = msg
    if (!pubkey) {
      this._sendError(conn, 'Missing pubkey')
      return
    }

    const account = this.syncManager.getAccount(pubkey)
    let syncStats = { blockCount: 0, lastDownloadAt: null, lastConnectedAt: null, peerConnected: false }
    if (account && account.active) {
      const bytes = this.syncFeed.getStorageUsed(account.swarmId)
      this.syncManager.updateStorageUsage(pubkey, bytes)
      syncStats = this.syncFeed.getSyncStats(account.swarmId)
    }

    const status = this.syncManager.getStatus(pubkey)
    this._sendSigned(conn, {
      type: 'sync_status',
      ...status,
      ...syncStats
    })
  }

  _sendError(conn, error) {
    this._sendSigned(conn, {
      type: 'sync_status',
      active: false,
      error
    })
  }

  _retryAllConnections() {
    if (!this.syncFeed.swarm?.connections) return

    for (const conn of this.syncFeed.swarm.connections) {
      if (conn.destroyed) continue

      if (!conn._syncChannel || conn._syncChannel.closed) {
        if (conn._syncPaired) {
          const mux = Protomux.from(conn)
          if (!mux.destroyed) {
            this._createChannel(mux, conn)
          }
        } else {
          this._setupProtomux(conn)
        }
      }
    }
  }

  close() {
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }
    if (this._gcInterval) {
      clearInterval(this._gcInterval)
      this._gcInterval = null
    }
    if (this._connectionHandler && this.syncFeed.swarm) {
      this.syncFeed.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }
    this._setupConnections.clear()
    console.log('[SyncProtocol] Closed')
  }
}
