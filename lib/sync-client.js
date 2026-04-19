/**
 * Sync Client - Connects to the sync server via Protomux
 *
 * Auth: nonce-challenge per channel.
 *   On channel open the server sends auth_challenge with a random nonce.
 *   We sign (nonce || 'auth_hello' || pubkey) with our Ed25519 identity key
 *   and reply with auth_hello. The server verifies, sends auth_ok, and all
 *   subsequent messages are bound to the authenticated pubkey.
 *
 * Per-connection state: each live connection to the sync server gets its own
 * auth state and message object. When we need to send a request we pick any
 * authed connection. This avoids a race where two channels open and the
 * "current" pointer flips between them — causing responses to go out on the
 * wrong channel and never reach the server.
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import dns from 'dns/promises'
import { verify as verifyEd25519 } from './identity.js'

const SYNC_PROTOCOL = 'swarmnero-sync-v1'

// Sync server swarm ID (Hypercore discovery key)
export const SYNC_SERVER_SWARM_ID = '5b1de522397602a3a5eb8ade5e47a66a666924b9a7e17e4605479bae6ec5c8b5'

// Pinned sync-server Ed25519 identity pubkey. Every server response is signed
// with this key and the client rejects anything that doesn't verify. Closes
// the MITM gap where a peer could impersonate the server on the same protocol.
export const SYNC_SERVER_PUBKEY = '6647c6d823dbcb7e10324cd19084e680e2b26de83b8824eeaf2ec95af2b011e7'
const SYNC_SERVER_PUBKEY_BYTES = b4a.from(SYNC_SERVER_PUBKEY, 'hex')

// Infrastructure host is identified by IP because Hyperswarm connections expose
// remoteHost as a numeric address, not a hostname. We resolve the public DNS
// name at startup and keep the IP on record; if DNS fails we fall back to the
// last known IP so users aren't stranded mid-migration.
export const SYNC_SERVER_HOSTNAME = 'sync.swarmnero.com'
export const SYNC_SERVER_FALLBACK_IP = '206.245.132.26'
const DNS_TIMEOUT_MS = 5000

let _syncServerHost = SYNC_SERVER_FALLBACK_IP
let _resolvePromise = null

/** Synchronous accessor — returns whatever IP we've resolved (or the fallback). */
export function getSyncServerHost() {
  return _syncServerHost
}

/**
 * Resolve the sync server hostname once per process. Callers should await this
 * before reading getSyncServerHost() if they want the live-DNS value; reading
 * beforehand returns the compiled-in fallback, which is safe but stale.
 */
export function resolveSyncServerHost() {
  if (_resolvePromise) return _resolvePromise
  _resolvePromise = (async () => {
    try {
      const lookup = dns.lookup(SYNC_SERVER_HOSTNAME, { family: 4 })
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)
      )
      const { address } = await Promise.race([lookup, timeout])
      if (address && /^\d+\.\d+\.\d+\.\d+$/.test(address)) {
        _syncServerHost = address
        console.log(`[SyncClient] Resolved ${SYNC_SERVER_HOSTNAME} → ${address}`)
      }
    } catch (err) {
      console.warn(
        `[SyncClient] DNS lookup failed for ${SYNC_SERVER_HOSTNAME}, using fallback ${SYNC_SERVER_FALLBACK_IP}:`,
        err.message
      )
    }
    return _syncServerHost
  })()
  return _resolvePromise
}

/**
 * Verify a server message's `sig` against the pinned server pubkey.
 * Signature covers JSON.stringify(msg) with the `sig` field removed.
 */
function verifyServerSig(msg) {
  if (!msg || typeof msg.sig !== 'string') return false
  let sigBuf
  try {
    sigBuf = b4a.from(msg.sig, 'hex')
  } catch {
    return false
  }
  if (sigBuf.length !== 64) return false
  const body = { ...msg }
  delete body.sig
  const payload = JSON.stringify(body)
  try {
    return verifyEd25519(payload, sigBuf, SYNC_SERVER_PUBKEY_BYTES)
  } catch {
    return false
  }
}

export class SyncClient {
  constructor({ feed, identity }) {
    this.feed = feed
    this.identity = identity
    this._pendingCallbacks = new Map() // type -> { resolve, timeout }
    this._authedConns = new Set()
    this._authWaiters = new Set()
    this._retryInterval = null
    this._connectionHandler = null
    this._initPromise = null
  }

  async init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    // Ensure the sync server IP is resolved before any connection can arrive —
    // _isServerConnection depends on the current value to flag VPS connections.
    await resolveSyncServerHost()

    const serverCore = await this.feed.follow(SYNC_SERVER_SWARM_ID, {
      skipFlush: false,
      infrastructure: true
    })

    if (this.feed.markInfrastructureHost) {
      this.feed.markInfrastructureHost(getSyncServerHost())
    }

    this._serverDiscoveryKey = serverCore?.discoveryKey
      ? b4a.toString(serverCore.discoveryKey, 'hex')
      : null

    this._connectionHandler = (conn, info) => {
      if (this._isServerConnection(conn, info)) {
        this._setupProtomux(conn)
      }
    }
    this.feed.swarm.on('connection', this._connectionHandler)

    if (this.feed.swarm.connections) {
      for (const conn of this.feed.swarm.connections) {
        if (!conn.destroyed && this._isServerConnection(conn)) {
          this._setupProtomux(conn)
        }
      }
    }

    this._retryInterval = setInterval(() => {
      if (!this.feed.swarm?.connections) return
      for (const conn of this.feed.swarm.connections) {
        if (conn.destroyed) continue
        if (!this._isServerConnection(conn)) continue
        if (!conn._syncChannel || conn._syncChannel.closed) {
          this._setupProtomux(conn)
        }
      }
    }, 10000)

    console.log('[SyncClient v3-per-conn] Initialized')
  }

  /**
   * True if this connection is to the sync server. We match on topics when
   * available (connection event) and fall back to the remote host IP for
   * existing connections. Filtering here is critical — without it we'd try
   * to open a sync channel on every peer connection, and stillborn channels
   * from non-server peers would compete for the "current" auth state.
   */
  _isServerConnection(conn, info) {
    if (info?.topics && this._serverDiscoveryKey) {
      if (info.topics.some(t => b4a.toString(t, 'hex') === this._serverDiscoveryKey)) {
        return true
      }
    }
    const host = conn?.rawStream?.remoteHost
    if (host && host === getSyncServerHost()) return true
    return false
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
      console.error('[SyncClient] Protomux error:', err.message)
    }
  }

  _createChannel(mux, conn) {
    if (conn._syncChannel && !conn._syncChannel.closed) return

    const channel = mux.createChannel({
      protocol: SYNC_PROTOCOL,
      unique: false,
      onopen: () => {
        console.log('[SyncClient] Channel opened on conn', this._connTag(conn))
        conn._syncAuthed = false
      },
      onclose: () => {
        console.log('[SyncClient] Channel closed on conn', this._connTag(conn))
        this._authedConns.delete(conn)
        conn._syncChannel = null
        conn._syncMessage = null
        conn._syncAuthed = false
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
    channel.open()
  }

  _connTag(conn) {
    const key = conn?.remotePublicKey
    return key ? b4a.toString(key, 'hex').slice(0, 8) : 'unknown'
  }

  _handleMessage(msg, conn) {
    // Reject any server message that isn't signed by the pinned pubkey.
    // This applies from the very first message (auth_challenge), so a MITM
    // can't even open an authenticated channel.
    if (!verifyServerSig(msg)) {
      console.warn('[SyncClient] Rejected unsigned/forged message from conn', this._connTag(conn), 'type:', msg?.type)
      return
    }

    if (msg.type === 'auth_challenge') {
      this._respondToChallenge(msg, conn)
      return
    }

    if (msg.type === 'auth_ok') {
      console.log('[SyncClient] Auth ok on conn', this._connTag(conn))
      this._onConnAuthed(conn)
      return
    }

    console.log('[SyncClient] Received:', msg.type, 'on conn', this._connTag(conn))

    const pending = this._pendingCallbacks.get(msg.type)
    if (pending) {
      clearTimeout(pending.timeout)
      this._pendingCallbacks.delete(msg.type)
      pending.resolve(msg)
    }

    if (msg.type === 'sync_status' && msg.active) {
      localStorage.setItem('swarmnero_sync_active', 'true')
      localStorage.setItem('swarmnero_sync_expires', msg.expiresAt?.toString() || '')
    }
  }

  _onConnAuthed(conn) {
    conn._syncAuthed = true
    this._authedConns.add(conn)
    const waiters = [...this._authWaiters]
    this._authWaiters.clear()
    for (const w of waiters) w.resolve(conn)
  }

  /**
   * Sign the nonce + 'auth_hello' + pubkey and send auth_hello back on the
   * SAME connection the challenge arrived on.
   */
  _respondToChallenge(msg, conn) {
    try {
      const nonce = b4a.from(msg.nonce, 'hex')
      const pubkey = this.identity.publicKey
      if (!pubkey) throw new Error('no identity pubkey')
      const payload = b4a.concat([
        nonce,
        b4a.from('auth_hello'),
        pubkey
      ])
      const sig = this.identity.sign(payload)

      if (conn._syncMessage) {
        conn._syncMessage.send({
          type: 'auth_hello',
          pubkey: this.identity.pubkeyHex,
          sig: b4a.toString(sig, 'hex')
        })
        console.log('[SyncClient] Sent auth_hello on conn', this._connTag(conn))
      }
    } catch (err) {
      console.error('[SyncClient] Challenge response error:', err.message)
    }
  }

  _firstAuthedConn() {
    for (const conn of this._authedConns) {
      if (conn.destroyed) continue
      if (conn._syncChannel && !conn._syncChannel.closed && conn._syncAuthed) {
        return conn
      }
    }
    return null
  }

  async _waitForAuth(timeoutMs = 15000) {
    const existing = this._firstAuthedConn()
    if (existing) return existing

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._authWaiters.delete(waiter)
        reject(new Error('auth timed out'))
      }, timeoutMs)
      const waiter = {
        resolve: (conn) => {
          clearTimeout(timer)
          this._authWaiters.delete(waiter)
          resolve(conn)
        }
      }
      this._authWaiters.add(waiter)
    })
  }

  async _sendAndWait(msg, responseType, timeoutMs = 30000) {
    let conn
    try {
      conn = await this._waitForAuth()
    } catch (err) {
      throw new Error('Not authenticated: ' + err.message)
    }
    if (!conn._syncMessage) {
      throw new Error('Not connected to sync server')
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingCallbacks.delete(responseType)
        reject(new Error('Sync server request timed out'))
      }, timeoutMs)
      this._pendingCallbacks.set(responseType, { resolve, timeout })
      console.log('[SyncClient] Sending', msg.type, 'on conn', this._connTag(conn))
      conn._syncMessage.send(msg)
    })
  }

  /**
   * Ask the server to enable feed backup for this account, using the
   * user's existing supporter-listing payment as proof. No new on-chain
   * payment is required — supporter = subscriber.
   */
  async enableBackup(txHash, txKey) {
    if (!txHash || !txKey) throw new Error('supporter tx_proof required')
    const msg = {
      type: 'sync_enable',
      pubkey: this.identity.pubkeyHex,
      swarmId: this.feed.swarmId,
      txHash,
      txKey
    }
    const response = await this._sendAndWait(msg, 'sync_status')
    if (!response.active) {
      throw new Error(response.error || 'Server rejected backup activation')
    }
    return response
  }

  /**
   * Ask the server to stop backing up this account. Server keeps the
   * account record (and expiresAt) so the user can re-enable for free
   * within their subscription window.
   */
  async disableBackup() {
    const msg = {
      type: 'sync_disable',
      pubkey: this.identity.pubkeyHex
    }
    const response = await this._sendAndWait(msg, 'sync_status')
    return response
  }

  async requestStatus() {
    const msg = {
      type: 'sync_status_request',
      pubkey: this.identity.pubkeyHex
    }

    const response = await this._sendAndWait(msg, 'sync_status')
    return response
  }

  get isConnected() {
    if (!this.feed?.swarm?.connections) return false
    for (const conn of this.feed.swarm.connections) {
      if (conn.destroyed) continue
      if (conn._syncChannel && !conn._syncChannel.closed) return true
    }
    return false
  }

  get isAuthenticated() {
    return !!this._firstAuthedConn()
  }

  close() {
    if (this._retryInterval) {
      clearInterval(this._retryInterval)
      this._retryInterval = null
    }
    if (this._connectionHandler && this.feed?.swarm) {
      this.feed.swarm.off('connection', this._connectionHandler)
      this._connectionHandler = null
    }
    for (const [, { timeout }] of this._pendingCallbacks) {
      clearTimeout(timeout)
    }
    this._pendingCallbacks.clear()
    for (const w of this._authWaiters) {
      try { w.resolve(null) } catch {}
    }
    this._authWaiters.clear()
    this._authedConns.clear()
    console.log('[SyncClient] Closed')
  }
}
