/**
 * Bookmarks - local "save for later" for posts.
 *
 * Storage model:
 *   - Each bookmark is an encrypted `private_data` event appended to the user's
 *     own feed (same event type used by paywall unlocks). The plaintext record
 *     is `{ kind: 'bookmark', post_pubkey, post_ts }` or, for removals,
 *     `{ kind: 'bookmark_remove', post_pubkey, post_ts }`.
 *   - Encryption uses `deriveLocalStorageKey(identity.secretKey)` so followers
 *     replicating our feed only see opaque ciphertext.
 *
 * Padding:
 *   - The plaintext record is padded to a fixed 256-byte boundary before
 *     encryption. This ensures bookmark `private_data` events are
 *     indistinguishable in size from each other. Without padding, a bookmark
 *     (~50B) and a paywall unlock (KBs) differ on the wire and the event size
 *     would leak "this is a bookmark" to a passive observer replicating the
 *     feed.
 *
 * IMPORTANT — key lifecycle:
 *   The encryption key is derived from the identity's Ed25519 secret key via
 *   `deriveLocalStorageKey`. It is NOT tied to the account password. The
 *   account password encrypts the identity file at rest, but once the app has
 *   loaded the identity into memory the bookmark key is available regardless
 *   of password state. If identity rotation is ever introduced (e.g. an
 *   Ed25519 key-rollover event), a migration must decrypt every existing
 *   `private_data` event under the OLD secret key and re-encrypt + re-append
 *   under the NEW key. No such migration exists today because no identity
 *   rotation path exists today. Add one together.
 */

import b4a from 'b4a'
import { EventType, createPrivateDataEvent } from './events.js'
import {
  encryptMessage,
  decryptMessage,
  deriveLocalStorageKey
} from './dm-crypto.js'

// Fixed plaintext size before encryption. 256 bytes comfortably fits the
// bookmark JSON envelope (kind + two 64-hex strings + a numeric timestamp)
// with room to spare; any overflow would throw at encrypt time rather than
// silently truncate.
const BOOKMARK_PLAINTEXT_SIZE = 256

// In-memory bookmark set: Set of "pubkey:timestamp" keys.
const bookmarks = new Set()

function postKey(pubkey, timestamp) {
  return `${pubkey}:${timestamp}`
}

/**
 * Pad a JSON string with spaces to exactly BOOKMARK_PLAINTEXT_SIZE bytes.
 * The JSON parser ignores trailing whitespace, so the pad is transparent on
 * decrypt. Throws if the input is already too large — no silent truncation.
 */
function padToFixedSize(json) {
  const bytes = b4a.byteLength(json, 'utf8')
  if (bytes > BOOKMARK_PLAINTEXT_SIZE) {
    throw new Error(`bookmark plaintext ${bytes}B exceeds ${BOOKMARK_PLAINTEXT_SIZE}B`)
  }
  if (bytes === BOOKMARK_PLAINTEXT_SIZE) return json
  return json + ' '.repeat(BOOKMARK_PLAINTEXT_SIZE - bytes)
}

/**
 * Append an encrypted bookmark record to the user's own feed.
 * @param {Object} feed - Feed instance
 * @param {Object} identity - Identity instance
 * @param {string} postPubkey - Author pubkey of the bookmarked post (hex)
 * @param {number} postTimestamp - Signed timestamp of the bookmarked post
 */
export async function addBookmark(feed, identity, postPubkey, postTimestamp) {
  if (!feed || !identity) throw new Error('feed and identity required')
  if (typeof postPubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(postPubkey)) {
    throw new Error('invalid postPubkey')
  }
  const ts = Number(postTimestamp)
  if (!Number.isFinite(ts)) throw new Error('invalid postTimestamp')

  const key = postKey(postPubkey, ts)
  if (bookmarks.has(key)) return false

  const localKey = deriveLocalStorageKey(identity.secretKey)
  const recordJson = JSON.stringify({
    kind: 'bookmark',
    post_pubkey: postPubkey,
    post_ts: ts
  })
  const padded = padToFixedSize(recordJson)
  const encrypted = encryptMessage(padded, localKey)
  await feed.append(createPrivateDataEvent({ encrypted }))

  bookmarks.add(key)
  return true
}

/**
 * Append a removal tombstone for a bookmark.
 */
export async function removeBookmark(feed, identity, postPubkey, postTimestamp) {
  if (!feed || !identity) throw new Error('feed and identity required')
  if (typeof postPubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(postPubkey)) {
    throw new Error('invalid postPubkey')
  }
  const ts = Number(postTimestamp)
  if (!Number.isFinite(ts)) throw new Error('invalid postTimestamp')

  const key = postKey(postPubkey, ts)
  if (!bookmarks.has(key)) return false

  const localKey = deriveLocalStorageKey(identity.secretKey)
  const recordJson = JSON.stringify({
    kind: 'bookmark_remove',
    post_pubkey: postPubkey,
    post_ts: ts
  })
  const padded = padToFixedSize(recordJson)
  const encrypted = encryptMessage(padded, localKey)
  await feed.append(createPrivateDataEvent({ encrypted }))

  bookmarks.delete(key)
  return true
}

/**
 * Scan own feed for private_data events, decrypt, and rebuild the bookmark set.
 */
export async function loadBookmarks(feed, identity) {
  if (!feed || !identity) return
  bookmarks.clear()

  try {
    const localKey = deriveLocalStorageKey(identity.secretKey)
    const events = await feed.read()

    // Sort our own events by timestamp so add/remove apply in the order they
    // were authored.
    const privateEvents = events
      .filter(ev => ev.type === EventType.PRIVATE_DATA && ev.encrypted)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))

    let loaded = 0
    for (const ev of privateEvents) {
      const json = decryptMessage(ev.encrypted, localKey)
      if (!json) continue

      let record
      try {
        record = JSON.parse(json)
      } catch {
        continue
      }

      if (!record || typeof record !== 'object') continue
      if (typeof record.post_pubkey !== 'string') continue
      if (!/^[a-f0-9]{64}$/i.test(record.post_pubkey)) continue
      const ts = Number(record.post_ts)
      if (!Number.isFinite(ts)) continue

      const key = postKey(record.post_pubkey, ts)
      if (record.kind === 'bookmark') {
        bookmarks.add(key)
        loaded++
      } else if (record.kind === 'bookmark_remove') {
        bookmarks.delete(key)
      }
      // Other kinds (e.g. paywall_unlock) are handled by their own module.
    }

    if (loaded > 0) {
      console.log(`[Bookmarks] Loaded ${bookmarks.size} bookmark(s)`)
    }
  } catch (err) {
    console.error('[Bookmarks] Error loading bookmarks:', err.message)
  }
}

export function isBookmarked(postPubkey, postTimestamp) {
  return bookmarks.has(postKey(postPubkey, Number(postTimestamp)))
}

/**
 * Return the current bookmark set as an array of `{post_pubkey, post_ts}`.
 */
export function getBookmarks() {
  const out = []
  for (const key of bookmarks) {
    const idx = key.indexOf(':')
    if (idx < 0) continue
    out.push({
      post_pubkey: key.slice(0, idx),
      post_ts: Number(key.slice(idx + 1))
    })
  }
  return out
}

/**
 * Count of current bookmarks (for UI badges).
 */
export function getBookmarkCount() {
  return bookmarks.size
}

/**
 * Clear in-memory state on logout / account switch.
 */
export function clearBookmarkState() {
  bookmarks.clear()
}
