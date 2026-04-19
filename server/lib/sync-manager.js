/**
 * Sync Manager - Account tracking, payment verification, expiry, storage caps
 */

import fs from 'fs'
import path from 'path'

// Storage cap per account (100MB)
const STORAGE_CAP_BYTES = 100 * 1024 * 1024

// Expiry period (12 months in ms)
const EXPIRY_MS = 365 * 24 * 60 * 60 * 1000

// Grace period after expiry (7 days)
const GRACE_MS = 7 * 24 * 60 * 60 * 1000

// Quote lifetime — how long a requiredAtomic price quote is valid from issuance
const QUOTE_LIFETIME_MS = 15 * 60 * 1000

// Tolerance on received vs required amount (0.5%) — covers float precision
// in USD→XMR conversion and tiny wallet fee rounding
const AMOUNT_TOLERANCE = 0.995

export class SyncManager {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.accounts = {} // pubkey -> account data
    this.subaddressMap = {} // subaddressIndex -> pubkey
    this.nextSubaddressIndex = 1
    this._filePath = path.join(dataDir, 'sync-accounts.json')
  }

  /**
   * Load accounts from disk
   */
  load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'))
        this.accounts = data.accounts || {}
        this.nextSubaddressIndex = data.nextSubaddressIndex || 1

        // Rebuild subaddress index
        for (const [pubkey, account] of Object.entries(this.accounts)) {
          if (account.subaddressIndex != null) {
            this.subaddressMap[account.subaddressIndex] = pubkey
          }
        }

        console.log(`[SyncManager] Loaded ${Object.keys(this.accounts).length} accounts`)
      } else {
        console.log('[SyncManager] No accounts file, starting fresh')
      }
    } catch (err) {
      console.error('[SyncManager] Error loading accounts:', err.message)
    }
  }

  /**
   * Save accounts to disk atomically (temp+rename, 0600)
   */
  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const data = {
        accounts: this.accounts,
        nextSubaddressIndex: this.nextSubaddressIndex
      }
      const tmp = this._filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, this._filePath)
      try { fs.chmodSync(this._filePath, 0o600) } catch (e) { /* ignore */ }
    } catch (err) {
      console.error('[SyncManager] Error saving accounts:', err.message)
    }
  }

  /**
   * Register a new account (before payment)
   * Returns the subaddress index to use for payment
   * @param {string} pubkey - Supporter's Ed25519 pubkey
   * @param {string} swarmId - Supporter's Hypercore swarmId
   * @returns {number} Subaddress index for payment
   */
  registerAccount(pubkey, swarmId) {
    // If already registered, return existing subaddress index
    if (this.accounts[pubkey]) {
      console.log(`[SyncManager] Account already registered: ${pubkey.slice(0, 16)}...`)
      return this.accounts[pubkey].subaddressIndex
    }

    const subaddressIndex = this.nextSubaddressIndex++

    this.accounts[pubkey] = {
      swarmId,
      subaddress: null, // Set after wallet generates it
      subaddressIndex,
      paymentTxHash: null,
      paymentAmount: null,
      paymentVerifiedAt: null,
      expiresAt: null,
      storageUsedBytes: 0,
      active: false,
      overCap: false,    // Set true once the account has exceeded its 100MB quota
      overCapAt: null,   // Timestamp the cap was hit
      createdAt: Date.now(),
      // Quote fields — set via setQuote() after registration
      requiredAtomic: null,  // string (BigInt serialized) of atomic XMR required
      quotedUsd: null,       // USD amount the quote was for
      quotedAt: null,        // timestamp quote was issued
      quoteExpiresAt: null   // timestamp quote becomes invalid for fresh requests
    }

    this.subaddressMap[subaddressIndex] = pubkey

    this.save()
    console.log(`[SyncManager] Registered account ${pubkey.slice(0, 16)}... with subaddress index ${subaddressIndex}`)
    return subaddressIndex
  }

  /**
   * Set or refresh the price quote for an account.
   * Called after registerAccount once the price oracle provides a rate.
   * @param {string} pubkey
   * @param {{ requiredAtomic: bigint, quotedUsd: number }} quote
   */
  setQuote(pubkey, { requiredAtomic, quotedUsd }) {
    const account = this.accounts[pubkey]
    if (!account) return false
    const now = Date.now()
    account.requiredAtomic = requiredAtomic.toString()
    account.quotedUsd = quotedUsd
    account.quotedAt = now
    account.quoteExpiresAt = now + QUOTE_LIFETIME_MS
    this.save()
    return true
  }

  /**
   * Get the required atomic amount for an account (as BigInt).
   * Returns null if no quote has been set.
   */
  getRequiredAtomic(pubkey) {
    const account = this.accounts[pubkey]
    if (!account?.requiredAtomic) return null
    try {
      return BigInt(account.requiredAtomic)
    } catch {
      return null
    }
  }

  /**
   * Check if a received amount satisfies the account's quote, with tolerance.
   * @param {string} pubkey
   * @param {bigint} receivedAtomic
   * @returns {boolean}
   */
  isPaymentSufficient(pubkey, receivedAtomic) {
    const required = this.getRequiredAtomic(pubkey)
    if (required == null) return false
    // receivedAtomic * 1000 >= required * 995 (tolerance 0.5%)
    return receivedAtomic * 1000n >= required * BigInt(Math.round(AMOUNT_TOLERANCE * 1000))
  }

  /**
   * Set the subaddress for an account (after wallet generates it)
   * @param {string} pubkey - Supporter's pubkey
   * @param {string} subaddress - Monero subaddress
   */
  setSubaddress(pubkey, subaddress) {
    if (this.accounts[pubkey]) {
      this.accounts[pubkey].subaddress = subaddress
      this.save()
    }
  }

  /**
   * Activate an account after payment is verified
   * @param {string} pubkey - Supporter's pubkey
   * @param {string} txHash - Transaction hash
   * @param {string} amount - Payment amount (atomic units string)
   */
  activateAccount(pubkey, txHash, amount) {
    const account = this.accounts[pubkey]
    if (!account) return false

    account.paymentTxHash = txHash
    account.paymentAmount = amount
    account.paymentVerifiedAt = Date.now()
    account.expiresAt = Date.now() + EXPIRY_MS
    account.active = true

    this.save()
    console.log(`[SyncManager] Activated account ${pubkey.slice(0, 16)}... expires ${new Date(account.expiresAt).toISOString()}`)
    return true
  }

  /**
   * Renew an account (extend expiry by 12 months from now)
   * @param {string} pubkey - Supporter's pubkey
   */
  renewAccount(pubkey, txHash, amount) {
    const account = this.accounts[pubkey]
    if (!account) return false

    account.paymentTxHash = txHash
    account.paymentAmount = amount
    account.paymentVerifiedAt = Date.now()
    account.expiresAt = Date.now() + EXPIRY_MS
    account.active = true

    this.save()
    console.log(`[SyncManager] Renewed account ${pubkey.slice(0, 16)}... expires ${new Date(account.expiresAt).toISOString()}`)
    return true
  }

  /**
   * Mark an account inactive (user disabled backup). Keeps paymentTxHash and
   * expiresAt so the user can re-enable for free within their subscription
   * period without a new payment.
   */
  deactivateAccount(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) return false
    account.active = false
    this.save()
    console.log(`[SyncManager] Deactivated account ${pubkey.slice(0, 16)}...`)
    return true
  }

  /**
   * Re-activate an existing, still-valid account without requiring a new
   * payment. Use when user toggles backup back on during their subscription
   * window. Does nothing if the account is expired — renewal needs tx proof.
   */
  reactivateAccount(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) return false
    if (!account.expiresAt || account.expiresAt < Date.now()) return false
    account.active = true
    this.save()
    console.log(`[SyncManager] Reactivated account ${pubkey.slice(0, 16)}...`)
    return true
  }

  /**
   * Get all active accounts (for feed following on startup)
   * Excludes accounts that have been capped or have lapsed.
   * @returns {Array<{pubkey, swarmId}>}
   */
  getActiveAccounts() {
    return Object.entries(this.accounts)
      .filter(([_, a]) => a.active && !a.overCap && a.expiresAt > Date.now())
      .map(([pubkey, a]) => ({ pubkey, swarmId: a.swarmId }))
  }

  /**
   * Get account info
   * @param {string} pubkey - Supporter's pubkey
   * @returns {Object|null}
   */
  getAccount(pubkey) {
    return this.accounts[pubkey] || null
  }

  /**
   * Find account by subaddress index
   * @param {number} index - Subaddress index
   * @returns {string|null} Pubkey of the account
   */
  getAccountBySubaddressIndex(index) {
    return this.subaddressMap[index] || null
  }

  /**
   * Update storage usage for an account
   * @param {string} pubkey - Supporter's pubkey
   * @param {number} bytes - Storage used in bytes
   */
  updateStorageUsage(pubkey, bytes) {
    if (this.accounts[pubkey]) {
      this.accounts[pubkey].storageUsedBytes = bytes
    }
  }

  /**
   * Check if account is over storage cap
   * @param {string} pubkey - Supporter's pubkey
   * @returns {boolean}
   */
  isOverStorageCap(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) return false
    return account.storageUsedBytes > STORAGE_CAP_BYTES
  }

  /**
   * Mark an account as having been capped (so we don't re-follow it on restart).
   * Deactivates and flags it — the account stays in the DB so the owner can
   * see status, but no data is replicated until they re-register fresh.
   * @param {string} pubkey - Supporter's pubkey
   */
  markOverCap(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) return false
    account.overCap = true
    account.overCapAt = Date.now()
    account.active = false
    this.save()
    console.log(`[SyncManager] Marked over-cap: ${pubkey.slice(0, 16)}...`)
    return true
  }

  /**
   * Whether poll-route reactivation should be allowed for this account.
   * Returns false for accounts whose subscription has lapsed — those
   * must renew via explicit authenticated sync_payment_proof.
   * @param {string} pubkey
   * @returns {boolean}
   */
  canReactivateViaPoll(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) return false
    if (account.overCap) return false
    if (account.expiresAt && account.expiresAt < Date.now()) return false
    return true
  }

  /**
   * Check all accounts for expiry
   * Returns list of accounts to deactivate and cleanup
   * @returns {{ expired: string[], graceExpired: string[] }}
   */
  checkExpiry() {
    const now = Date.now()
    const expired = [] // In grace period
    const graceExpired = [] // Past grace period, cleanup

    for (const [pubkey, account] of Object.entries(this.accounts)) {
      if (!account.active) continue

      if (account.expiresAt && account.expiresAt < now) {
        if (account.expiresAt + GRACE_MS < now) {
          // Past grace period - full cleanup
          graceExpired.push(pubkey)
          account.active = false
        } else {
          // In grace period - mark as expired but keep data
          expired.push(pubkey)
        }
      }
    }

    if (expired.length > 0 || graceExpired.length > 0) {
      this.save()
      console.log(`[SyncManager] Expiry check: ${expired.length} in grace, ${graceExpired.length} past grace`)
    }

    return { expired, graceExpired }
  }

  /**
   * Remove an account entirely (after grace period)
   * @param {string} pubkey - Supporter's pubkey
   */
  removeAccount(pubkey) {
    const account = this.accounts[pubkey]
    if (account) {
      delete this.subaddressMap[account.subaddressIndex]
    }
    delete this.accounts[pubkey]
    this.save()
    console.log(`[SyncManager] Removed account ${pubkey.slice(0, 16)}...`)
  }

  /**
   * Get status info for a supporter
   * @param {string} pubkey - Supporter's pubkey
   * @returns {Object}
   */
  getStatus(pubkey) {
    const account = this.accounts[pubkey]
    if (!account) {
      return { active: false, error: 'Account not found' }
    }

    return {
      active: account.active,
      expiresAt: account.expiresAt,
      storageUsed: account.storageUsedBytes,
      storageLimit: STORAGE_CAP_BYTES,
      paymentVerifiedAt: account.paymentVerifiedAt
    }
  }
}

export { STORAGE_CAP_BYTES, EXPIRY_MS, QUOTE_LIFETIME_MS }
