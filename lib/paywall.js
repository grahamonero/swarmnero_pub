/**
 * Paywall - Encrypted post content gated behind XMR payment
 *
 * Encryption flow:
 *   1. Author generates a random 32-byte symmetric contentKey
 *   2. Encrypts post body with contentKey via crypto_secretbox_easy
 *   3. Posts the ciphertext + price + preview + per-post Monero subaddress
 *   4. Stores contentKey locally in paywall-keys.json (keyed by post timestamp)
 *
 * Buyer flow:
 *   1. Buyer pays via existing wallet.createTransaction() + wallet.relayTransaction()
 *   2. Buyer's app appends an unlock_request event to its own feed with the txHash + txKey
 *
 * Author scanner (background):
 *   1. Reads unlock_request events from peer feeds
 *   2. For each one targeting one of our paywalled posts, verifies via wallet.checkTxKey
 *   3. Derives shared key with the buyer (DM-style X25519 DH)
 *   4. Encrypts our local contentKey with the shared key
 *   5. Appends a key_release event to our own feed
 *   6. Marks (post_timestamp, tx_hash) as processed locally so we don't double-release
 *
 * Buyer scanner (background):
 *   1. Reads key_release events from peer feeds
 *   2. For each one addressed to our pubkey, derives shared key with the author
 *   3. Decrypts the encrypted_key to recover the post's contentKey
 *   4. Decrypts the post body
 *   5. Stores the decrypted content as a private_data event in our own feed
 *      (encrypted with a key derived from our identity, so followers can't read it)
 *
 * Render flow:
 *   - On startup, scan our own feed for private_data events and decrypt them locally
 *   - Build an in-memory Map: post_pubkey:post_timestamp -> { content, media }
 *   - When rendering a paywalled post, check the map first.
 *     If unlocked, render the decrypted content. Otherwise render the preview + Unlock button.
 */

import sodium from 'sodium-native'
import b4a from 'b4a'
import {
  EventType,
  isPaywalledPost,
  createUnlockRequestEvent,
  createKeyReleaseEvent,
  createPrivateDataEvent
} from './events.js'
import { verifyEventSignature } from './feed.js'
import {
  deriveX25519Keys,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  deriveLocalStorageKey
} from './dm-crypto.js'
import {
  setContentKey,
  getContentKey,
  isUnlockProcessed,
  markUnlockProcessed
} from './paywall-storage.js'
import * as wallet from './wallet.js'

// In-memory map of unlocked content: "pubkey:timestamp" -> { content, media }
const unlockedContent = new Map()

// In-memory record of what we've already broadcast to private_data so we don't dup
const storedPrivateUnlocks = new Set()

function postKey(pubkey, timestamp) {
  return `${pubkey}:${timestamp}`
}

/**
 * ATOMIC <-> XMR conversion
 */
const ATOMIC_PER_XMR = 1_000_000_000_000n

function xmrToAtomic(xmrStr) {
  // xmrStr like "0.001"; convert to BigInt atomic units
  const [whole, frac = ''] = String(xmrStr).split('.')
  const fracPadded = (frac + '000000000000').slice(0, 12)
  return BigInt(whole) * ATOMIC_PER_XMR + BigInt(fracPadded)
}

/**
 * Author: prepare paywall fields for a new post.
 *
 * Returns the fields to merge into createPostEvent({ ... }), plus the raw
 * contentKey hex so the caller can persist it AFTER feed.append() assigns the
 * real timestamp (we don't know the timestamp ahead of time).
 *
 * @param {Object} args
 * @param {string} args.content - Plaintext content (will be encrypted)
 * @param {Array}  args.media   - Media metadata (will be encrypted)
 * @param {string} args.priceXmr - Price in XMR as a string, e.g. "0.001"
 * @param {string} args.preview - Public preview text
 * @returns {Promise<Object>} { paywallPrice, paywallPreview, paywallEncrypted, paywallSubaddress, paywallSubaddressIndex, contentKeyHex }
 *
 * NOTE: This function generates a fresh subaddress via wallet.getReceiveAddress(true).
 * Caller must have an unlocked wallet.
 */
export async function createPaywalledPost({ content, media, priceXmr, preview }) {
  if (!wallet.isWalletUnlocked()) {
    throw new Error('Wallet must be unlocked to create a paywalled post')
  }
  if (!priceXmr || isNaN(parseFloat(priceXmr)) || parseFloat(priceXmr) <= 0) {
    throw new Error('Invalid price')
  }

  // Generate random 32-byte content key
  const contentKey = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.randombytes_buf(contentKey)

  // Encrypt the post body (content + media metadata) as JSON
  const payload = JSON.stringify({ content: content || '', media: media || [] })
  const paywallEncrypted = encryptMessage(payload, contentKey)

  // Generate fresh subaddress for this paywall
  const subAddr = await wallet.getReceiveAddress(true)

  return {
    paywallPrice: String(priceXmr),
    paywallPreview: preview || '',
    paywallEncrypted,
    paywallSubaddress: subAddr.address,
    paywallSubaddressIndex: subAddr.index,
    contentKeyHex: b4a.toString(contentKey, 'hex')
  }
}

/**
 * Persist a content key under a known post timestamp.
 * Call this AFTER feed.append() returns the appended entry with its real timestamp.
 */
export function persistContentKey(postTimestamp, contentKeyHex) {
  setContentKey(postTimestamp, contentKeyHex)
}

/**
 * Author: scan peer feeds for unlock_request events targeting our posts and process them.
 *
 * Verification model (v0.7):
 *   - Look up the txHash in our wallet's transaction history
 *   - Confirm it's an incoming transfer to the post's paywall_subaddress with sufficient amount
 *   - First-come-first-serve per txHash (idempotent via processed-unlocks.json)
 *   - If the txHash is not yet visible in our wallet, trigger an immediate sync and retry next tick
 *
 * @param {Object} feed - Feed instance
 * @param {Object} identity - Identity instance (with x25519Keys derived)
 * @returns {Promise<number>} Number of releases sent
 */
export async function processIncomingUnlockRequests(feed, identity) {
  if (!feed || !identity) return 0
  if (!wallet.isWalletUnlocked()) return 0 // need wallet to verify payments

  let releaseCount = 0

  try {
    // Build a quick map of our own paywalled posts: timestamp -> post
    const ourEvents = await feed.read()
    const ourPaywalled = new Map()
    const subaddressToPost = new Map() // subaddress_index -> post
    for (const ev of ourEvents) {
      if (ev.type === EventType.POST && isPaywalledPost(ev) && ev.pubkey === identity.pubkeyHex) {
        ourPaywalled.set(ev.timestamp, ev)
        if (ev.paywall_subaddress_index != null) {
          subaddressToPost.set(ev.paywall_subaddress_index, ev)
        }
      }
    }

    if (ourPaywalled.size === 0) return 0

    // Derive our X25519 keys once
    const myX25519 = deriveX25519Keys(identity.secretKey)

    // Scan all peer events for unlock_request targeting our posts
    const all = await feed.getTimeline(2000)
    const pendingRequests = []
    for (const ev of all) {
      if (ev.type !== EventType.UNLOCK_REQUEST) continue
      if (ev.post_pubkey !== identity.pubkeyHex) continue

      const post = ourPaywalled.get(ev.post_timestamp)
      if (!post) continue
      if (!ev.tx_hash || !ev.buyer_pubkey) continue
      if (isUnlockProcessed(ev.post_timestamp, ev.tx_hash)) continue

      // Verify signature and that the event signer matches the claimed buyer
      if (!verifyEventSignature(ev)) continue
      if (ev.pubkey !== ev.buyer_pubkey) continue

      pendingRequests.push({ ev, post })
    }

    if (pendingRequests.length === 0) return 0

    // Load wallet transactions once for the batch
    let walletTxs = []
    try {
      walletTxs = await wallet.getTransactions(1000)
    } catch (err) {
      console.warn('[Paywall] getTransactions error:', err.message)
      return 0
    }

    // Build a map: txid -> tx for quick lookup
    const txByHash = new Map()
    for (const tx of walletTxs) {
      if (tx && tx.txid) txByHash.set(tx.txid, tx)
    }

    // Check if any requests reference a tx we don't have yet — if so, trigger an immediate sync
    let needsSync = false
    for (const { ev } of pendingRequests) {
      if (!txByHash.has(ev.tx_hash)) {
        needsSync = true
        break
      }
    }

    if (needsSync) {
      console.log('[Paywall] Unknown txHash referenced — triggering immediate wallet sync')
      try {
        await wallet.sync()
        // Re-fetch transactions after sync
        walletTxs = await wallet.getTransactions(1000)
        txByHash.clear()
        for (const tx of walletTxs) {
          if (tx && tx.txid) txByHash.set(tx.txid, tx)
        }
      } catch (err) {
        console.warn('[Paywall] On-demand sync failed:', err.message)
      }
    }

    const MIN_CONFIRMATIONS = 3

    for (const { ev, post } of pendingRequests) {
      const tx = txByHash.get(ev.tx_hash)
      if (!tx) {
        // Still not visible in wallet — leave unprocessed for next tick (don't mark)
        console.log(`[Paywall] tx ${ev.tx_hash.slice(0, 12)} not yet in wallet for unlock from ${ev.buyer_pubkey.slice(0, 8)}`)
        continue
      }

      if (!tx.isIncoming) {
        console.log(`[Paywall] tx ${ev.tx_hash.slice(0, 12)} is not incoming — rejecting`)
        markUnlockProcessed(ev.post_timestamp, ev.tx_hash)
        continue
      }

      // Require sufficient confirmations to defeat 0-conf double-spend attacks.
      // Do NOT mark processed here — wait for confirmations to accumulate.
      const confirmations = tx.confirmations || 0
      if (confirmations < MIN_CONFIRMATIONS) {
        console.log(`[Paywall] tx ${ev.tx_hash.slice(0, 12)} has ${confirmations} confirmations, need ${MIN_CONFIRMATIONS} — waiting`)
        continue
      }

      // Verify this incoming tx targeted our post's specific subaddress
      const expectedIndex = post.paywall_subaddress_index
      if (expectedIndex == null || !tx.subaddressIndices?.includes(expectedIndex)) {
        console.log(`[Paywall] tx ${ev.tx_hash.slice(0, 12)} did not target post subaddress index ${expectedIndex}`)
        markUnlockProcessed(ev.post_timestamp, ev.tx_hash)
        continue
      }

      // Verify amount is at least the price (use atomic units)
      const required = xmrToAtomic(post.paywall_price)
      const received = BigInt(tx.amount.toString())
      if (received < required) {
        console.log(`[Paywall] Underpayment for post ${ev.post_timestamp}: got ${received}, required ${required}`)
        markUnlockProcessed(ev.post_timestamp, ev.tx_hash)
        continue
      }

      // Look up the local content key
      const hexKey = getContentKey(ev.post_timestamp)
      if (!hexKey) {
        console.warn(`[Paywall] No content key found for post ${ev.post_timestamp}`)
        // Don't mark processed — if the key becomes available we want to retry
        continue
      }

      // Derive shared key with buyer (DM-style)
      const buyerPkBuf = b4a.from(ev.buyer_pubkey, 'hex')
      const sharedKey = deriveSharedKey(buyerPkBuf, myX25519.secretKey)

      // Encrypt the contentKey with the shared key
      const encryptedKey = encryptMessage(hexKey, sharedKey)

      // Append key_release event to our own feed
      const releaseEvent = createKeyReleaseEvent({
        postTimestamp: ev.post_timestamp,
        buyerPubkey: ev.buyer_pubkey,
        encryptedKey
      })
      await feed.append(releaseEvent)

      markUnlockProcessed(ev.post_timestamp, ev.tx_hash)
      releaseCount++
      console.log(`[Paywall] Released key for post ${ev.post_timestamp} to buyer ${ev.buyer_pubkey.slice(0, 8)}`)
    }
  } catch (err) {
    console.error('[Paywall] Error processing unlock requests:', err.message)
  }

  return releaseCount
}

/**
 * Cache decrypted content for a post in the in-memory unlocked map.
 * Used by the author after creating a paywalled post so they see their own
 * content normally (the author has the contentKey and never needs to "unlock" it).
 */
export function cacheUnlockedContent(pubkey, timestamp, content, media) {
  unlockedContent.set(postKey(pubkey, timestamp), { content, media: media || [] })
}

/**
 * Buyer: scan peer feeds for key_release events addressed to us, decrypt them,
 * decrypt the matching paywalled post, and store the result locally as a
 * private_data event in our own feed.
 *
 * @param {Object} feed - Feed instance
 * @param {Object} identity - Identity instance
 * @returns {Promise<number>} Number of new unlocks added
 */
export async function processIncomingKeyReleases(feed, identity) {
  if (!feed || !identity) return 0

  let newUnlocks = 0

  try {
    const myX25519 = deriveX25519Keys(identity.secretKey)
    const all = await feed.getTimeline(2000)

    // Build a map of paywalled posts we know about: "pubkey:timestamp" -> post
    const paywalledPosts = new Map()
    for (const ev of all) {
      if (ev.type === EventType.POST && isPaywalledPost(ev)) {
        paywalledPosts.set(postKey(ev.pubkey, ev.timestamp), ev)
      }
    }

    for (const ev of all) {
      if (ev.type !== EventType.KEY_RELEASE) continue
      if (ev.buyer_pubkey !== identity.pubkeyHex) continue
      if (!ev.encrypted_key || !ev.pubkey) continue
      if (!verifyEventSignature(ev)) continue

      // The author of the release is ev.pubkey (set by feed.append on signing)
      const authorPubkey = ev.pubkey
      const pk = postKey(authorPubkey, ev.post_timestamp)

      // Skip if we already have this unlocked
      if (unlockedContent.has(pk)) continue

      const post = paywalledPosts.get(pk)
      if (!post) continue // we don't have the post yet

      // Derive shared key with author
      const authorPkBuf = b4a.from(authorPubkey, 'hex')
      const sharedKey = deriveSharedKey(authorPkBuf, myX25519.secretKey)

      // Decrypt the contentKey
      const hexContentKey = decryptMessage(ev.encrypted_key, sharedKey)
      if (!hexContentKey) {
        console.warn(`[Paywall] Failed to decrypt key_release for post ${ev.post_timestamp}`)
        continue
      }

      // Decrypt the post body
      const contentKey = b4a.from(hexContentKey, 'hex')
      const payloadJson = decryptMessage(post.paywall_encrypted, contentKey)
      if (!payloadJson) {
        console.warn(`[Paywall] Failed to decrypt post body ${ev.post_timestamp}`)
        continue
      }

      let payload
      try {
        payload = JSON.parse(payloadJson)
      } catch (err) {
        console.warn(`[Paywall] Invalid payload JSON for post ${ev.post_timestamp}`)
        continue
      }

      // Cache in memory
      unlockedContent.set(pk, payload)
      newUnlocks++

      // Persist as a private_data event in our own feed
      if (!storedPrivateUnlocks.has(pk)) {
        try {
          const localKey = deriveLocalStorageKey(identity.secretKey)
          const recordJson = JSON.stringify({
            kind: 'paywall_unlock',
            post_pubkey: authorPubkey,
            post_timestamp: ev.post_timestamp,
            content: payload.content,
            media: payload.media
          })
          const encrypted = encryptMessage(recordJson, localKey)
          await feed.append(createPrivateDataEvent({ encrypted }))
          storedPrivateUnlocks.add(pk)
        } catch (err) {
          console.warn('[Paywall] Failed to store private_data for unlock:', err.message)
        }
      }

      console.log(`[Paywall] Unlocked post ${ev.post_timestamp} from ${authorPubkey.slice(0, 8)}`)
    }
  } catch (err) {
    console.error('[Paywall] Error processing key releases:', err.message)
  }

  return newUnlocks
}

/**
 * Startup: populate the in-memory unlockedContent map from two sources:
 *   1. Buyer-side: private_data events in our own feed (posts we've paid to unlock)
 *   2. Author-side: our own paywalled posts decrypted with the contentKey we stored locally
 *
 * @param {Object} feed - Feed instance
 * @param {Object} identity - Identity instance
 */
export async function loadUnlockedFromFeed(feed, identity) {
  if (!feed || !identity) return

  try {
    const localKey = deriveLocalStorageKey(identity.secretKey)
    const events = await feed.read()

    let buyerCount = 0
    let authorCount = 0

    for (const ev of events) {
      // Buyer-side: load private_data unlocks
      if (ev.type === EventType.PRIVATE_DATA && ev.encrypted) {
        const json = decryptMessage(ev.encrypted, localKey)
        if (!json) continue

        let record
        try {
          record = JSON.parse(json)
        } catch {
          continue
        }

        if (record.kind !== 'paywall_unlock') continue
        if (!record.post_pubkey || !record.post_timestamp) continue

        const pk = postKey(record.post_pubkey, record.post_timestamp)
        unlockedContent.set(pk, { content: record.content, media: record.media })
        storedPrivateUnlocks.add(pk)
        buyerCount++
        continue
      }

      // Author-side: decrypt our own paywalled posts using locally-stored contentKey
      if (ev.type === EventType.POST && isPaywalledPost(ev) && ev.pubkey === identity.pubkeyHex) {
        const hexKey = getContentKey(ev.timestamp)
        if (!hexKey) continue // we don't have the key — skip
        try {
          const contentKey = b4a.from(hexKey, 'hex')
          const payloadJson = decryptMessage(ev.paywall_encrypted, contentKey)
          if (!payloadJson) continue
          const payload = JSON.parse(payloadJson)
          const pk = postKey(ev.pubkey, ev.timestamp)
          unlockedContent.set(pk, { content: payload.content, media: payload.media || [] })
          authorCount++
        } catch (err) {
          // skip on decryption failure
        }
      }
    }

    if (buyerCount > 0 || authorCount > 0) {
      console.log(`[Paywall] Loaded ${buyerCount} buyer unlock(s) and ${authorCount} author post(s)`)
    }
  } catch (err) {
    console.error('[Paywall] Error loading unlocks from feed:', err.message)
  }
}

/**
 * Get unlocked content for a paywalled post (or null if not unlocked)
 * @param {string} pubkey - Post author pubkey
 * @param {number} timestamp - Post timestamp
 * @returns {{ content, media }|null}
 */
export function getUnlockedContent(pubkey, timestamp) {
  return unlockedContent.get(postKey(pubkey, timestamp)) || null
}

/**
 * Returns true if the user has unlocked this post
 */
export function isPostUnlocked(pubkey, timestamp) {
  return unlockedContent.has(postKey(pubkey, timestamp))
}

/**
 * Clear in-memory state (for logout / account switch)
 */
export function clearUnlockedState() {
  unlockedContent.clear()
  storedPrivateUnlocks.clear()
}
