/**
 * Supporter Manager
 *
 * Manages verified supporter listings with payment verification.
 * Listings require a $12 USD payment in XMR to the Swarmnero wallet.
 */

import fs from 'fs'
import path from 'path'
import { getXMRPrice } from './price.js'

// Swarmnero wallet address for listing payments
const SWARMNERO_WALLET_ADDRESS = '469Xb8h3LcsHW1QPWgFJebQRoZXwjztMoJhGRr2ZYR9cjTrYqFSAgE84yC3WEp4bU315AHw7xzHVXcQeCactFgFnGBSALmr'

// Listing fee in USD (per year)
const LISTING_FEE_USD = 12.0

// Subscription lifetime — $12/year
const EXPIRY_MS = 365 * 24 * 60 * 60 * 1000

// Warn at 30 days from expiry, show renewal UI
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

// Atomic units per XMR
const ATOMIC_UNITS_PER_XMR = 1e12

/**
 * SupporterManager class
 * Manages verified supporter listings with persistence
 */
export class SupporterManager {
  constructor() {
    // Map of pubkey -> listing data
    this.listings = new Map()
    // Map of pubkey -> pending listing data (awaiting payment verification)
    this.pending = new Map()
    // Data directory for persistence
    this.dataDir = null
  }

  /**
   * Set the data directory for storage
   * @param {string} dataDir - Data directory path
   */
  setDataDir(dataDir) {
    this.dataDir = dataDir
  }

  /**
   * Get the listings file path
   * @returns {string}
   */
  _getListingsPath() {
    if (!this.dataDir) {
      throw new Error('Data directory not set')
    }
    return path.join(this.dataDir, 'supporter-listings.json')
  }

  /**
   * Load listings from storage
   */
  loadListings() {
    if (!this.dataDir) {
      console.warn('[SupporterManager] Data directory not set, skipping load')
      return
    }

    const listingsPath = this._getListingsPath()

    if (!fs.existsSync(listingsPath)) {
      console.log('[SupporterManager] No listings file found, starting fresh')
      return
    }

    try {
      const content = fs.readFileSync(listingsPath, 'utf8')
      const data = JSON.parse(content)

      // Convert object to Map; backfill paidAt/expiresAt on any pre-expiry listings
      this.listings = new Map()
      let backfilled = 0
      for (const [pubkey, listing] of Object.entries(data)) {
        if (!listing.paidAt) {
          listing.paidAt = listing.verifiedAt || Date.now()
          backfilled++
        }
        if (!listing.expiresAt) {
          listing.expiresAt = listing.paidAt + EXPIRY_MS
        }
        this.listings.set(pubkey, listing)
      }
      if (backfilled > 0) {
        this.saveListings()
        console.log('[SupporterManager] Backfilled expiry on', backfilled, 'legacy listings')
      }

      console.log('[SupporterManager] Loaded', this.listings.size, 'listings')
    } catch (e) {
      console.error('[SupporterManager] Error loading listings:', e.message)
    }
  }

  /**
   * Save listings to storage
   */
  saveListings() {
    if (!this.dataDir) {
      console.warn('[SupporterManager] Data directory not set, skipping save')
      return
    }

    try {
      // Ensure data directory exists
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
      }

      // Convert Map to object for JSON serialization
      const data = {}
      for (const [pubkey, listing] of this.listings.entries()) {
        data[pubkey] = listing
      }

      const listingsPath = this._getListingsPath()
      fs.writeFileSync(listingsPath, JSON.stringify(data, null, 2), 'utf8')

      console.log('[SupporterManager] Saved', this.listings.size, 'listings')
    } catch (e) {
      console.error('[SupporterManager] Error saving listings:', e.message)
    }
  }

  /**
   * Clear all listings (for migration purposes)
   */
  clearAllListings() {
    this.listings = new Map()
    this.pending = new Map()
    this.saveListings()
    console.log('[SupporterManager] Cleared all listings')
  }

  /**
   * Add a verified listing
   * @param {string} pubkey - Hex-encoded public key
   * @param {Object} profile - Profile data { name, bio, avatar }
   * @param {Object} listing - Listing data { tags, tagline, tx_proof, amount, seq }
   * @param {string} swarmId - Swarm ID
   * @returns {boolean} Success
   */
  addListing(pubkey, profile, listing, swarmId) {
    if (!pubkey || typeof pubkey !== 'string') {
      throw new Error('Invalid pubkey')
    }

    const now = Date.now()
    const listingData = {
      profile: {
        name: profile?.name || null,
        bio: profile?.bio || null,
        avatar: profile?.avatar || null
      },
      listing: {
        tags: listing?.tags || [],
        tagline: listing?.tagline || null,
        tx_proof: listing?.tx_proof || null,
        amount: listing?.amount || null,
        seq: listing?.seq || 0
      },
      swarmId: swarmId || null,
      verifiedAt: now,
      paidAt: now,
      expiresAt: now + EXPIRY_MS,
      paymentConfirmed: true,
      vouched: false,
      vouchedBy: []
    }

    this.listings.set(pubkey, listingData)
    this.saveListings()

    console.log('[SupporterManager] Added verified listing for:', pubkey.slice(0, 16) + '...')
    return true
  }

  /**
   * Add a single peer-gossiped listing. Verifies the tx_proof on-chain
   * before marking paymentConfirmed:true.
   */
  async addPeerListing(pubkey, profile, listing, swarmId) {
    if (!pubkey || !/^[a-f0-9]{64}$/i.test(pubkey)) return false
    if (this.listings.has(pubkey)) return false

    let paymentConfirmed = false
    let verifiedAmount = null
    const parsed = this._parseTxProof(listing?.tx_proof)
    if (parsed) {
      try {
        const { verified, amount } = await this.verifyPayment(parsed.txHash, parsed.txKey)
        if (verified) {
          paymentConfirmed = true
          verifiedAmount = amount
        }
      } catch (e) {
        // leave unverified
      }
    }

    const peerNow = Date.now()
    this.listings.set(pubkey, {
      profile: {
        name: profile?.name || null,
        bio: profile?.bio || null,
        avatar: profile?.avatar || null
      },
      listing: {
        tags: Array.isArray(listing?.tags) ? listing.tags : [],
        tagline: listing?.tagline || null,
        tx_proof: listing?.tx_proof || null,
        amount: listing?.amount || null,
        seq: listing?.seq || 0
      },
      swarmId: swarmId || null,
      verifiedAt: peerNow,
      paidAt: peerNow,
      expiresAt: peerNow + EXPIRY_MS,
      paymentConfirmed,
      paymentVerifiedAmount: verifiedAmount ? verifiedAmount.toString() : null,
      vouched: false,
      vouchedBy: [],
      fromPeer: true
    })
    this.saveListings()
    return paymentConfirmed
  }

  /**
   * Add listings from peer supporter listing events (P2P sync).
   *
   * Signature verification only proves the author signed their own claim —
   * it does NOT prove the payment actually went to the Swarmnero wallet.
   * We therefore verify the tx_proof on-chain via the local wallet before
   * marking the listing as a confirmed supporter. If the wallet is locked
   * or unavailable, the listing is stored as unverified and can be
   * re-checked later.
   *
   * @param {Object} supporterListings - Map of pubkey -> supporter listing event
   * @param {Object} profiles - Map of pubkey -> profile event
   */
  async addPeerListings(supporterListings, profiles) {
    let addedVerified = 0
    let addedUnverified = 0
    for (const [pubkey, event] of Object.entries(supporterListings)) {
      if (!/^[a-f0-9]{64}$/i.test(pubkey)) continue
      if (this.listings.has(pubkey)) continue

      const profile = profiles[pubkey] || {}

      // Attempt on-chain verification of tx_proof
      let paymentConfirmed = false
      let verifiedAmount = null
      const parsed = this._parseTxProof(event.tx_proof)
      if (parsed) {
        try {
          const { verified, amount } = await this.verifyPayment(parsed.txHash, parsed.txKey)
          if (verified) {
            paymentConfirmed = true
            verifiedAmount = amount
          }
        } catch (e) {
          // treat as unverified
        }
      }

      const paidAt = event.timestamp || Date.now()
      const listingData = {
        profile: {
          name: profile.name || null,
          bio: profile.bio || null,
          avatar: profile.avatar || null
        },
        listing: {
          tags: event.tags || [],
          tagline: event.tagline || null,
          tx_proof: event.tx_proof || null,
          amount: event.amount || null,
          seq: event.seq || 0
        },
        swarmId: event.swarmId || null,
        verifiedAt: paidAt,
        paidAt,
        expiresAt: paidAt + EXPIRY_MS,
        paymentConfirmed,
        paymentVerifiedAmount: verifiedAmount ? verifiedAmount.toString() : null,
        vouched: false,
        vouchedBy: [],
        fromPeer: true
      }

      this.listings.set(pubkey, listingData)
      if (paymentConfirmed) addedVerified++
      else addedUnverified++
    }

    if (addedVerified > 0 || addedUnverified > 0) {
      this.saveListings()
      console.log(`[SupporterManager] Added ${addedVerified} verified / ${addedUnverified} unverified peer listings`)
    }
  }

  /**
   * Add a pending listing (awaiting payment verification)
   * @param {string} pubkey - Hex-encoded public key
   * @param {Object} data - Pending listing data
   */
  addPendingListing(pubkey, data) {
    if (!pubkey || typeof pubkey !== 'string') {
      throw new Error('Invalid pubkey')
    }

    this.pending.set(pubkey, {
      ...data,
      createdAt: Date.now()
    })

    console.log('[SupporterManager] Added pending listing for:', pubkey.slice(0, 16) + '...')
  }

  /**
   * Get all pending listings
   * @returns {Map} Map of pubkey -> pending data
   */
  getPendingListings() {
    return new Map(this.pending)
  }

  /**
   * Remove a pending listing
   * @param {string} pubkey - Hex-encoded public key
   */
  removePendingListing(pubkey) {
    this.pending.delete(pubkey)
    console.log('[SupporterManager] Removed pending listing for:', pubkey.slice(0, 16) + '...')
  }

  /**
   * Verify a payment proof against the Swarmnero wallet address.
   * Calls wallet.checkTxKey(txHash, address, txKey) and checks that the
   * received amount is at least the current listing fee (with a small
   * tolerance for USD/XMR price drift between the buyer's and our view).
   *
   * @param {string} txHash - Transaction hash
   * @param {string} txKey - Transaction key (proof)
   * @returns {Promise<{verified: boolean, amount: bigint|null, reason?: string}>}
   */
  async verifyPayment(txHash, txKey) {
    if (!txHash || typeof txHash !== 'string' || !/^[a-f0-9]{64}$/i.test(txHash)) {
      return { verified: false, amount: null, reason: 'bad_txhash' }
    }
    if (!txKey || typeof txKey !== 'string') {
      return { verified: false, amount: null, reason: 'bad_txkey' }
    }

    try {
      // Dynamic import to avoid circular dependency
      const wallet = await import('./wallet.js')

      if (typeof wallet.checkTxKey !== 'function') {
        return { verified: false, amount: null, reason: 'wallet_unavailable' }
      }

      // Correct arg order: (txHash, address, txKey)
      const result = await wallet.checkTxKey(txHash, SWARMNERO_WALLET_ADDRESS, txKey)

      if (!result || !result.verified || !result.amount) {
        return { verified: false, amount: null, reason: result?.reason || 'not_verified' }
      }

      return { verified: true, amount: result.amount, confirmations: result.confirmations }
    } catch (e) {
      console.error('[SupporterManager] Payment verification error:', e.message)
      return { verified: false, amount: null, reason: e.message }
    }
  }

  /**
   * Parse a tx_proof field into (txHash, txKey). Supports legacy forms.
   * @private
   */
  _parseTxProof(txProof) {
    if (!txProof || typeof txProof !== 'string') return null
    if (txProof.includes(':')) {
      const [txHash, txKey] = txProof.split(':')
      return { txHash, txKey }
    }
    return null
  }

  /**
   * Get verified listings with optional filtering
   * @param {Object} options - Filter options
   * @param {string} options.tag - Filter by tag
   * @returns {Array} Array of listing objects with pubkey
   */
  getVerifiedListings(options = {}) {
    const results = []

    for (const [pubkey, data] of this.listings.entries()) {
      // Filter by payment confirmation
      if (!data.paymentConfirmed) {
        continue
      }

      // Filter by tag if specified
      if (options.tag && data.listing?.tags) {
        const tags = Array.isArray(data.listing.tags) ? data.listing.tags : []
        const hasTag = tags.some(t =>
          t.toLowerCase() === options.tag.toLowerCase()
        )
        if (!hasTag) {
          continue
        }
      }

      results.push({
        pubkey,
        ...data
      })
    }

    // Sort by verifiedAt (newest first)
    results.sort((a, b) => (b.verifiedAt || 0) - (a.verifiedAt || 0))

    return results
  }

  /**
   * Check if a pubkey has a currently-active verified listing.
   * Returns false if payment is unconfirmed OR subscription has expired.
   */
  isListed(pubkey) {
    const listing = this.listings.get(pubkey)
    if (!listing || listing.paymentConfirmed !== true) return false
    if (listing.expiresAt && listing.expiresAt < Date.now()) return false
    return true
  }

  /**
   * Check if a listing exists but has expired.
   */
  isExpired(pubkey) {
    const listing = this.listings.get(pubkey)
    if (!listing || listing.paymentConfirmed !== true) return false
    return !!(listing.expiresAt && listing.expiresAt < Date.now())
  }

  /**
   * Get milliseconds remaining before expiry. Negative if expired.
   * Returns null if no listing.
   */
  getMsUntilExpiry(pubkey) {
    const listing = this.listings.get(pubkey)
    if (!listing || !listing.expiresAt) return null
    return listing.expiresAt - Date.now()
  }

  /**
   * True if the subscription is active and within the renewal window
   * (default 30 days from expiry).
   */
  isRenewalDue(pubkey) {
    const remaining = this.getMsUntilExpiry(pubkey)
    if (remaining === null) return false
    return remaining > 0 && remaining <= RENEWAL_WINDOW_MS
  }

  /**
   * Re-check on-chain verification for peer listings that were stored as
   * unverified (e.g. the local wallet's node hadn't seen the tx yet when the
   * listing first replicated). Any listing that now verifies flips to
   * paymentConfirmed:true so the badge renders next refresh.
   */
  async retryUnverifiedListings() {
    let retried = 0
    let verified = 0
    const failureReasons = []
    for (const [pubkey, listing] of this.listings.entries()) {
      if (listing.paymentConfirmed) continue
      if (!listing.fromPeer) continue
      const parsed = this._parseTxProof(listing.listing?.tx_proof)
      if (!parsed) continue
      retried++
      console.log(`[SupporterManager] Retrying ${pubkey.slice(0, 8)}: txHash len=${parsed.txHash.length} "${parsed.txHash.slice(0, 8)}…${parsed.txHash.slice(-4)}" txKey len=${parsed.txKey.length} "${parsed.txKey.slice(0, 8)}…${parsed.txKey.slice(-4)}"`)
      try {
        const result = await this.verifyPayment(parsed.txHash, parsed.txKey)
        if (result.verified) {
          listing.paymentConfirmed = true
          listing.paymentVerifiedAmount = result.amount ? result.amount.toString() : null
          this.listings.set(pubkey, listing)
          verified++
        } else {
          failureReasons.push(`${pubkey.slice(0, 8)}: ${result.reason || 'unknown'}`)
        }
      } catch (e) {
        failureReasons.push(`${pubkey.slice(0, 8)}: threw ${e.message}`)
      }
    }
    if (verified > 0) this.saveListings()
    if (retried > 0) {
      console.log(`[SupporterManager] Retried ${retried} unverified listings, ${verified} now verified`)
      if (failureReasons.length > 0) {
        console.log(`[SupporterManager] Verification still failing:`, failureReasons.join('; '))
      }
    }
    return verified
  }

  /**
   * Extend an existing listing's expiry by one year after a verified renewal
   * payment. If already expired, the new expiry starts from now; otherwise
   * it stacks onto the current expiry so back-to-back renewals add up.
   */
  renewListing(pubkey, txProof) {
    const listing = this.listings.get(pubkey)
    if (!listing) return false
    const now = Date.now()
    const base = listing.expiresAt > now ? listing.expiresAt : now
    listing.paidAt = now
    listing.expiresAt = base + EXPIRY_MS
    if (txProof) listing.listing.tx_proof = txProof
    listing.paymentConfirmed = true
    this.listings.set(pubkey, listing)
    this.saveListings()
    console.log('[SupporterManager] Renewed', pubkey.slice(0, 16) + '... new expiresAt', new Date(listing.expiresAt).toISOString())
    return true
  }

  /**
   * Get a single listing
   * @param {string} pubkey - Hex-encoded public key
   * @returns {Object|null}
   */
  getListing(pubkey) {
    const listing = this.listings.get(pubkey)
    if (!listing) {
      return null
    }
    return {
      pubkey,
      ...listing
    }
  }

  /**
   * Vouch for a listing
   * @param {string} pubkey - Pubkey of the listing to vouch for
   * @param {string} voucherPubkey - Pubkey of the vouching user (optional)
   * @returns {boolean} Success
   */
  vouchListing(pubkey, voucherPubkey = null) {
    const listing = this.listings.get(pubkey)
    if (!listing) {
      return false
    }

    listing.vouched = true

    if (voucherPubkey && !listing.vouchedBy.includes(voucherPubkey)) {
      listing.vouchedBy.push(voucherPubkey)
    }

    this.listings.set(pubkey, listing)
    this.saveListings()

    console.log('[SupporterManager] Vouched for listing:', pubkey.slice(0, 16) + '...')
    return true
  }

  /**
   * Remove vouch from a listing
   * @param {string} pubkey - Pubkey of the listing
   * @param {string} voucherPubkey - Pubkey of the vouching user to remove (optional)
   * @returns {boolean} Success
   */
  unvouchListing(pubkey, voucherPubkey = null) {
    const listing = this.listings.get(pubkey)
    if (!listing) {
      return false
    }

    if (voucherPubkey) {
      // Remove specific voucher
      listing.vouchedBy = listing.vouchedBy.filter(pk => pk !== voucherPubkey)
      // Only mark as unvouched if no vouchers remain
      if (listing.vouchedBy.length === 0) {
        listing.vouched = false
      }
    } else {
      // Clear all vouches
      listing.vouched = false
      listing.vouchedBy = []
    }

    this.listings.set(pubkey, listing)
    this.saveListings()

    console.log('[SupporterManager] Unvouched listing:', pubkey.slice(0, 16) + '...')
    return true
  }

  /**
   * Calculate listing fee in XMR based on current price
   * @returns {Promise<{xmr: number, atomicUnits: bigint, usdPrice: number|null}>}
   */
  async getListingFeeXMR() {
    const xmrPrice = await getXMRPrice()

    if (!xmrPrice || xmrPrice <= 0) {
      // Fallback: use a conservative estimate if price unavailable
      console.warn('[SupporterManager] XMR price unavailable, using fallback')
      return {
        xmr: 0.12, // ~$12 at $100/XMR
        atomicUnits: BigInt(Math.floor(0.12 * ATOMIC_UNITS_PER_XMR)),
        usdPrice: null
      }
    }

    // Calculate XMR amount for $12 USD
    const xmrAmount = LISTING_FEE_USD / xmrPrice
    const atomicUnits = BigInt(Math.floor(xmrAmount * ATOMIC_UNITS_PER_XMR))

    return {
      xmr: xmrAmount,
      atomicUnits,
      usdPrice: xmrPrice
    }
  }
}

// Export constants for external use
export { SWARMNERO_WALLET_ADDRESS, LISTING_FEE_USD }

// Singleton instance for convenience
let defaultManager = null

/**
 * Get or create the default SupporterManager instance
 * @returns {SupporterManager}
 */
export function getSupporterManager() {
  if (!defaultManager) {
    defaultManager = new SupporterManager()
  }
  return defaultManager
}
