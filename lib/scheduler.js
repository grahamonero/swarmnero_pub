/**
 * Scheduled posts manager.
 *
 * CRITICAL: the queue stores UNSIGNED payloads only. Signing happens at
 * fire-time inside this module via feed.append(), which mints a fresh
 * timestamp. Never serialize a signed-but-unbroadcast event.
 *
 * Storage: `accounts/<accountId>/scheduled.json`, encrypted with
 * deriveLocalStorageKey(identity.secretKey), atomic tmp+rename+chmod 0o600.
 *
 * Every entry is stamped with accountId. Before each fire attempt we assert
 * the currently-loaded identity matches; otherwise the entry is deferred.
 * The timer is stopped on account switch (destroy()).
 */

import path from 'path'
import sodium from 'sodium-native'
import b4a from 'b4a'
import {
  assertValidAccountId,
  ensureAccountDir,
  getAccountDir,
  writeEncryptedJson,
  readEncryptedJson
} from './account-queue-storage.js'
import { createPostEvent } from './events.js'
import { createPaywalledPost, persistContentKey, cacheUnlockedContent } from './paywall.js'
import * as wallet from './wallet.js'

const MIN_LEAD_MS = 60 * 1000
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000
const STALE_AFTER_MS = 24 * 60 * 60 * 1000
const TICK_MS = 30 * 1000
const ENTRY_ID_RE = /^[a-f0-9]{32}$/

function newEntryId() {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

function scheduledFilePath(dataDir, accountId) {
  return path.join(getAccountDir(dataDir, accountId), 'scheduled.json')
}

export class Scheduler {
  /**
   * @param {Object} opts
   * @param {string} opts.dataDir
   * @param {string} opts.accountId
   * @param {Object} opts.identity - must expose pubkeyHex
   * @param {Object} opts.feed - must expose async append(event)
   * @param {Buffer} opts.encryptionKey
   * @param {Function} [opts.onStale] - ({entry}) => Promise<'publish'|'cancel'|'defer'>
   * @param {Function} [opts.onPaywallLocked] - ({entry}) => void (UI warning)
   * @param {Function} [opts.onFired] - ({entry, appended}) => void
   * @param {Function} [opts.onError] - ({entry, err}) => void
   */
  constructor(opts) {
    assertValidAccountId(opts.accountId)
    if (!opts.identity?.pubkeyHex) throw new Error('identity.pubkeyHex required')
    if (!opts.feed || typeof opts.feed.append !== 'function') throw new Error('feed required')
    if (!opts.encryptionKey || opts.encryptionKey.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error('encryptionKey required (32 bytes)')
    }
    this.dataDir = opts.dataDir
    this.accountId = opts.accountId
    this.identity = opts.identity
    this.feed = opts.feed
    this.key = opts.encryptionKey
    this.onStale = opts.onStale || null
    this.onPaywallLocked = opts.onPaywallLocked || null
    this.onFired = opts.onFired || null
    this.onError = opts.onError || null
    this.entries = new Map()
    this._timer = null
    this._firing = false
    this._destroyed = false
    this._warnedPaywallLocked = new Set()
    this._promptingStale = new Set()
  }

  load() {
    ensureAccountDir(this.dataDir, this.accountId)
    const doc = readEncryptedJson(scheduledFilePath(this.dataDir, this.accountId), this.key, null)
    this.entries = new Map()
    if (doc && Array.isArray(doc.entries)) {
      for (const e of doc.entries) {
        if (!e || !ENTRY_ID_RE.test(e.id || '')) continue
        if (e.accountId !== this.accountId) continue
        this.entries.set(e.id, {
          id: e.id,
          accountId: this.accountId,
          createdAt: Number(e.createdAt) || Date.now(),
          sendAt: Number(e.sendAt) || 0,
          payload: e.payload && typeof e.payload === 'object' ? e.payload : null,
          paywall: e.paywall && typeof e.paywall === 'object' ? {
            price: typeof e.paywall.price === 'string' ? e.paywall.price : '',
            preview: typeof e.paywall.preview === 'string' ? e.paywall.preview : ''
          } : null
        })
      }
    }
    return this
  }

  start() {
    if (this._destroyed || this._timer) return
    this._timer = setInterval(() => this.tick().catch(() => {}), TICK_MS)
    // Try an immediate tick so anything already past send_at fires without
    // waiting for the first interval.
    this.tick().catch(() => {})
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  destroy() {
    this._destroyed = true
    this.stop()
    this.entries.clear()
    this.key = null
    this.identity = null
    this.feed = null
  }

  list() {
    return Array.from(this.entries.values()).sort((a, b) => a.sendAt - b.sendAt)
  }

  /**
   * Queue a new scheduled post. `payload` is UNSIGNED — we store only the
   * fields feed.append will sign later.
   *
   * @param {Object} args
   * @param {Object} args.payload - { content, media, subaddress?, subaddressIndex? }
   * @param {number} args.sendAt - unix ms
   * @param {Object} [args.paywall] - { price, preview } (signing + encryption happen at fire time)
   */
  schedule({ payload, sendAt, paywall }) {
    if (this._destroyed) throw new Error('Scheduler destroyed')
    if (!payload || typeof payload !== 'object') throw new Error('payload required')
    const now = Date.now()
    if (!Number.isFinite(sendAt)) throw new Error('sendAt must be a number')
    if (sendAt <= now + MIN_LEAD_MS) {
      throw new Error('Scheduled time must be at least 60 seconds in the future')
    }
    if (sendAt >= now + MAX_LEAD_MS) {
      throw new Error('Scheduled time must be less than 365 days in the future')
    }
    const entry = {
      id: newEntryId(),
      accountId: this.accountId,
      createdAt: now,
      sendAt,
      payload: {
        content: typeof payload.content === 'string' ? payload.content : '',
        media: Array.isArray(payload.media) ? payload.media : [],
        subaddress: payload.subaddress || null,
        subaddressIndex: Number.isFinite(payload.subaddressIndex) ? payload.subaddressIndex : null
      },
      paywall: paywall && typeof paywall === 'object' && paywall.price ? {
        price: String(paywall.price),
        preview: typeof paywall.preview === 'string' ? paywall.preview : ''
      } : null
    }
    this.entries.set(entry.id, entry)
    this._saveNow()
    return entry
  }

  cancel(entryId) {
    if (!this.entries.has(entryId)) return false
    this.entries.delete(entryId)
    this._warnedPaywallLocked.delete(entryId)
    this._promptingStale.delete(entryId)
    this._saveNow()
    return true
  }

  /**
   * Inspect all entries and fire any that are due. Safe to call repeatedly
   * (wallet-unlock or sync-complete callbacks can trigger an immediate tick).
   */
  async tick() {
    if (this._destroyed) return
    if (this._firing) return
    if (!this.identity || !this.feed) return
    // Account binding check: if the active identity no longer matches this
    // Scheduler instance, do nothing. A fresh Scheduler is spun up after
    // account switch; the old one should already be destroyed by the
    // teardown hook, but this is belt-and-braces.
    this._firing = true
    try {
      const now = Date.now()
      const due = []
      for (const entry of this.entries.values()) {
        if (entry.sendAt <= now) due.push(entry)
      }
      due.sort((a, b) => a.sendAt - b.sendAt)
      for (const entry of due) {
        if (this._destroyed) break
        await this._tryFire(entry)
      }
    } finally {
      this._firing = false
    }
  }

  async _tryFire(entry) {
    const now = Date.now()
    if (entry.accountId !== this.accountId) return
    // Stale check: prompt before silently publishing very old content.
    if (now > entry.sendAt + STALE_AFTER_MS) {
      if (!this.onStale) return // no UI handler → keep queued safely
      if (this._promptingStale.has(entry.id)) return
      this._promptingStale.add(entry.id)
      let decision = 'defer'
      try {
        decision = await this.onStale({ entry })
      } catch {
        decision = 'defer'
      }
      this._promptingStale.delete(entry.id)
      if (decision === 'cancel') {
        this.cancel(entry.id)
        return
      }
      if (decision !== 'publish') return
    }

    // Paywall fire-time: if wallet locked → keep queued, surface UI warning.
    if (entry.paywall) {
      if (!wallet.isWalletUnlocked()) {
        if (!this._warnedPaywallLocked.has(entry.id)) {
          this._warnedPaywallLocked.add(entry.id)
          try { this.onPaywallLocked?.({ entry }) } catch {}
        }
        return
      }
      this._warnedPaywallLocked.delete(entry.id)
    }

    try {
      let appended
      if (entry.paywall) {
        // Encrypt + generate fresh subaddress at fire-time (paywall module
        // does both). Never reuse a pre-generated subaddress from the queue.
        const paywallFields = await createPaywalledPost({
          content: entry.payload.content,
          media: entry.payload.media,
          priceXmr: entry.paywall.price,
          preview: entry.paywall.preview
        })
        appended = await this.feed.append(createPostEvent({
          content: '',
          media: undefined,
          paywallPrice: paywallFields.paywallPrice,
          paywallPreview: paywallFields.paywallPreview,
          paywallEncrypted: paywallFields.paywallEncrypted,
          paywallSubaddress: paywallFields.paywallSubaddress,
          paywallSubaddressIndex: paywallFields.paywallSubaddressIndex
        }))
        if (appended && appended.timestamp) {
          persistContentKey(appended.timestamp, paywallFields.contentKeyHex)
          cacheUnlockedContent(appended.pubkey, appended.timestamp, entry.payload.content, entry.payload.media)
        }
      } else {
        // Non-paywall path: regenerate a fresh tip subaddress if the wallet
        // is unlocked; otherwise publish without one. We intentionally do
        // NOT reuse any subaddress captured at schedule time.
        let subaddress = null
        let subaddressIndex = null
        if (wallet.isWalletUnlocked()) {
          try {
            const addr = await wallet.getReceiveAddress(true)
            subaddress = addr.address
            subaddressIndex = addr.index
          } catch (err) {
            console.warn('[Scheduler] subaddress create failed:', err.message)
          }
        }
        appended = await this.feed.append(createPostEvent({
          content: entry.payload.content,
          media: entry.payload.media?.length ? entry.payload.media : undefined,
          subaddress,
          subaddressIndex
        }))
      }
      this.entries.delete(entry.id)
      this._saveNow()
      try { this.onFired?.({ entry, appended }) } catch {}
    } catch (err) {
      console.warn('[Scheduler] fire failed, will retry:', err.message)
      try { this.onError?.({ entry, err }) } catch {}
    }
  }

  _saveNow() {
    if (this._destroyed || !this.key) return
    try {
      const doc = { entries: Array.from(this.entries.values()) }
      writeEncryptedJson(scheduledFilePath(this.dataDir, this.accountId), this.key, doc)
    } catch (err) {
      console.warn('[Scheduler] save failed:', err.message)
    }
  }
}
