/**
 * Event types for Swarmnero social network
 *
 * All events are appended to user's Hypercore feed.
 * Signature and timestamp are added by the Feed class.
 */

import { extractHashtags } from './tag-extractor.js'

export const EventType = {
  PROFILE: 'profile',
  POST: 'post',
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
  REPLY: 'reply',
  LIKE: 'like',
  REACTION: 'reaction',
  REPOST: 'repost',
  TIP: 'tip',
  TIP_RECEIVED: 'tip_received',  // Author announces tips they received
  DELETE: 'delete',
  DISCOVERY_PROFILE: 'discovery_profile',
  SUPPORTER_LISTING: 'supporter_listing',
  REPLY_METADATA: 'reply_metadata',  // OP announces who replied (for thread visibility)
  // Paywall event types
  UNLOCK_REQUEST: 'unlock_request',  // Buyer pays + announces intent to unlock a paywalled post
  KEY_RELEASE: 'key_release',        // Author releases content key encrypted to a specific buyer
  PRIVATE_DATA: 'private_data',      // Generic encrypted personal data (used to store unlocked content locally)
  // DM event types (stored in DM cores, not public feed)
  DM_MESSAGE: 'dm_message',
  DM_MEDIA: 'dm_media',
  DM_READ: 'dm_read'
}

/**
 * Create a profile update event.
 *
 * `swarmId` is a self-attested binding: the author's Ed25519 signature over
 * this event proves that the holder of `pubkey` claims their feed lives at
 * Hypercore key `swarmId`. Other peers can forward this signed event and
 * the receiver can verify the binding without having to trust the forwarder.
 */
export function createProfileEvent({ name, bio, avatar, website, moneroAddress, swarmId }) {
  return {
    type: EventType.PROFILE,
    name: name || '',
    bio: bio || '',
    avatar: avatar || null,
    website: website || null,
    monero_address: moneroAddress || null,
    swarmId: swarmId || null
  }
}

/**
 * Create a post event
 *
 * Paywall fields are optional. When set, the post body is encrypted and only
 * the preview text is publicly visible. Buyers pay to paywall_subaddress to
 * trigger an unlock_request event; the author then publishes a key_release
 * event that delivers the content key encrypted to the buyer.
 */
export function createPostEvent({
  content,
  media,
  subaddress,
  subaddressIndex,
  paywallPrice,
  paywallPreview,
  paywallEncrypted,
  paywallSubaddress,
  paywallSubaddressIndex
}) {
  const event = {
    type: EventType.POST,
    content,
    tags: extractHashtags(content || ''),
    media: media || [],
    subaddress: subaddress || null,
    subaddress_index: subaddressIndex || null
  }

  if (paywallPrice && paywallEncrypted) {
    event.paywall_price = paywallPrice                       // string XMR amount, e.g. "0.001"
    event.paywall_preview = paywallPreview || ''             // public preview text
    event.paywall_encrypted = paywallEncrypted               // { nonce, ciphertext } hex
    event.paywall_subaddress = paywallSubaddress || null
    event.paywall_subaddress_index = paywallSubaddressIndex || null
  }

  return event
}

/**
 * Check if a post event is paywalled (has encrypted content)
 */
export function isPaywalledPost(post) {
  return !!(post && post.paywall_price && post.paywall_encrypted)
}

/**
 * Create an unlock_request event - buyer announces they paid to unlock a post
 */
export function createUnlockRequestEvent({ postPubkey, postTimestamp, txHash, txKey, buyerPubkey }) {
  return {
    type: EventType.UNLOCK_REQUEST,
    post_pubkey: postPubkey,
    post_timestamp: postTimestamp,
    tx_hash: txHash,
    tx_key: txKey,
    buyer_pubkey: buyerPubkey
  }
}

/**
 * Create a key_release event - author delivers a decryption key to a specific buyer
 * The encrypted_key field contains the post's contentKey encrypted with the
 * shared key derived from the author's secret + buyer's pubkey.
 */
export function createKeyReleaseEvent({ postTimestamp, buyerPubkey, encryptedKey }) {
  return {
    type: EventType.KEY_RELEASE,
    post_timestamp: postTimestamp,
    buyer_pubkey: buyerPubkey,
    encrypted_key: encryptedKey
  }
}

/**
 * Create a private_data event - generic encrypted personal data stored in the user's own feed
 * Used by paywall to store decrypted/unlocked content. Encrypted with a key
 * derived from the user's own identity, so followers replicating the feed
 * cannot read the contents (only the user themselves can).
 */
export function createPrivateDataEvent({ encrypted }) {
  return {
    type: EventType.PRIVATE_DATA,
    encrypted // { nonce, ciphertext } hex
  }
}

/**
 * Create a follow event
 */
export function createFollowEvent({ swarmId }) {
  return {
    type: EventType.FOLLOW,
    swarm_id: swarmId
  }
}

/**
 * Create an unfollow event
 */
export function createUnfollowEvent({ swarmId }) {
  return {
    type: EventType.UNFOLLOW,
    swarm_id: swarmId
  }
}

/**
 * Create a reply event
 */
export function createReplyEvent({ toPubkey, postTimestamp, content, media }) {
  return {
    type: EventType.REPLY,
    to_pubkey: toPubkey,
    post_timestamp: postTimestamp,
    content,
    media: media || []
  }
}

/**
 * Create a like event
 */
export function createLikeEvent({ toPubkey, postTimestamp }) {
  return {
    type: EventType.LIKE,
    to_pubkey: toPubkey,
    post_timestamp: postTimestamp
  }
}

// The canonical emoji that old `like` events normalize to.
export const LIKE_EMOJI = '\u2764\uFE0F'

// Unicode-aware emoji validator. Accepts a single extended-grapheme cluster
// whose first code point carries the Extended_Pictographic property (or the
// Regional Indicator pair used for flags). Rejects empty/null/multi-grapheme,
// plain ASCII letters/digits, and control characters. Kept permissive within
// the emoji space (skin-tone + ZWJ sequences still validate as one grapheme).
const EMOJI_RANGE_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|[\u{1F3FB}-\u{1F3FF}]|\p{Emoji_Modifier}|\p{Emoji_Component})*$/u

export function isValidReactionEmoji(emoji) {
  if (typeof emoji !== 'string') return false
  if (emoji.length === 0 || emoji.length > 64) return false

  // Must be exactly one extended-grapheme cluster.
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const iter = seg.segment(emoji)[Symbol.iterator]()
    const first = iter.next()
    if (first.done) return false
    if (!iter.next().done) return false
    if (first.value.segment !== emoji) return false
  } catch {
    // If Segmenter unavailable fall through to regex (still enforces ranges).
  }

  return EMOJI_RANGE_RE.test(emoji)
}

/**
 * Create a reaction event (NIP-25-style). `emoji` must be a single grapheme
 * cluster within the Unicode emoji ranges; validated at ingest AND escaped at
 * every render site.
 */
export function createReactionEvent({ toPubkey, postTimestamp, emoji }) {
  if (!isValidReactionEmoji(emoji)) {
    throw new Error('Invalid reaction emoji')
  }
  return {
    type: EventType.REACTION,
    to_pubkey: toPubkey,
    post_timestamp: postTimestamp,
    emoji
  }
}

// Anti-spam: drop >1 reaction event per (reacter, target) per REACTION_COOLDOWN_MS.
const REACTION_COOLDOWN_MS = 5000

// Normalize a reaction-shaped event (including legacy `like`). Returns a
// plain record {reacter, target, emoji, timestamp, seq} or null if the event
// is malformed/invalid and must be dropped.
function normalizeReactionEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  if (typeof ev.pubkey !== 'string') return null
  if (typeof ev.to_pubkey !== 'string') return null
  if (typeof ev.post_timestamp !== 'number' && typeof ev.post_timestamp !== 'string') return null
  const postTs = Number(ev.post_timestamp)
  if (!Number.isFinite(postTs)) return null
  const ts = Number(ev.timestamp)
  if (!Number.isFinite(ts)) return null

  if (ev.type === EventType.LIKE) {
    return {
      reacter: ev.pubkey,
      target: `${ev.to_pubkey}:${postTs}`,
      emoji: LIKE_EMOJI,
      timestamp: ts,
      seq: Number.isFinite(ev._seq) ? ev._seq : 0
    }
  }
  if (ev.type === EventType.REACTION) {
    if (!isValidReactionEmoji(ev.emoji)) return null
    return {
      reacter: ev.pubkey,
      target: `${ev.to_pubkey}:${postTs}`,
      emoji: ev.emoji,
      timestamp: ts,
      seq: Number.isFinite(ev._seq) ? ev._seq : 0
    }
  }
  return null
}

// Pick the winning record when we see two keyed by (reacter, target, emoji).
// Latest timestamp wins; Hypercore seq # breaks ties (spec requires non-wall-clock tiebreak).
function reactionWins(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp ? a : b
  return a.seq >= b.seq ? a : b
}

/**
 * Aggregate reactions for a post. Handles:
 *   - dedupe by (reacter, target, emoji) — latest wins, tiebreak Hypercore seq
 *   - anti-spam: drop 2nd+ reaction event per (reacter, target) within 5s
 *   - backwards-compat: legacy `like` events normalize to LIKE_EMOJI and share
 *     a bucket with `reaction:'❤️'` from the same pubkey (no double-counting)
 *   - optional per-event signature verification (mirror paywall.js:189)
 *
 * @param {Array} events    Events (already loaded from feed/peer cores).
 * @param {string} toPubkey Target post author pubkey.
 * @param {number|string} postTimestamp Target post timestamp.
 * @param {Object} [opts]
 * @param {(ev:Object)=>boolean} [opts.verify] Signature verifier. If provided,
 *   events that fail verification are silently dropped.
 * @returns {Array<{emoji:string,count:number,reacters:string[]}>}
 */
export function aggregateReactions(events, toPubkey, postTimestamp, opts = {}) {
  const { verify } = opts
  const targetKey = `${toPubkey}:${Number(postTimestamp)}`

  // First pass: anti-spam gate per (reacter, target). Keep earliest event in
  // each 5s window.
  const lastSeenByReacter = new Map() // reacter -> last accepted timestamp
  const accepted = []

  // Sort events by timestamp so the 5s window is applied deterministically.
  const sorted = [...events].sort((a, b) => {
    const ta = Number(a.timestamp) || 0
    const tb = Number(b.timestamp) || 0
    if (ta !== tb) return ta - tb
    const sa = Number.isFinite(a._seq) ? a._seq : 0
    const sb = Number.isFinite(b._seq) ? b._seq : 0
    return sa - sb
  })

  for (const ev of sorted) {
    if (ev.type !== EventType.LIKE && ev.type !== EventType.REACTION) continue
    const norm = normalizeReactionEvent(ev)
    if (!norm) continue
    if (norm.target !== targetKey) continue
    if (verify && !verify(ev)) continue

    const prev = lastSeenByReacter.get(norm.reacter)
    if (prev !== undefined && (norm.timestamp - prev) < REACTION_COOLDOWN_MS) {
      continue
    }
    lastSeenByReacter.set(norm.reacter, norm.timestamp)
    accepted.push(norm)
  }

  // Second pass: dedupe by (reacter, target, emoji), latest-wins.
  const byKey = new Map()
  for (const rec of accepted) {
    const key = `${rec.reacter}|${rec.target}|${rec.emoji}`
    const existing = byKey.get(key)
    if (!existing || reactionWins(rec, existing) === rec) {
      byKey.set(key, rec)
    }
  }

  // Collapse legacy-like into LIKE_EMOJI bucket already handled by
  // normalizeReactionEvent. But if the same pubkey has BOTH an old `like` AND
  // a new `reaction:'❤️'`, we must count them as one: keep the newest record.
  const perEmoji = new Map() // emoji -> Map(reacter -> record)
  for (const rec of byKey.values()) {
    let bucket = perEmoji.get(rec.emoji)
    if (!bucket) {
      bucket = new Map()
      perEmoji.set(rec.emoji, bucket)
    }
    const existing = bucket.get(rec.reacter)
    if (!existing || reactionWins(rec, existing) === rec) {
      bucket.set(rec.reacter, rec)
    }
  }

  const out = []
  for (const [emoji, bucket] of perEmoji) {
    out.push({
      emoji,
      count: bucket.size,
      reacters: Array.from(bucket.keys())
    })
  }
  // Stable order: most-used first, then emoji codepoint for determinism.
  out.sort((a, b) => (b.count - a.count) || a.emoji.localeCompare(b.emoji))
  return out
}

/**
 * Get the emoji the given user has reacted with, or null if none.
 * Respects the same dedupe/anti-spam/legacy-normalization rules as
 * aggregateReactions.
 */
export function getUserReaction(events, userPubkey, toPubkey, postTimestamp, opts = {}) {
  const buckets = aggregateReactions(events, toPubkey, postTimestamp, opts)
  for (const b of buckets) {
    if (b.reacters.includes(userPubkey)) return b.emoji
  }
  return null
}

/**
 * Create a repost event
 */
export function createRepostEvent({ toPubkey, postTimestamp, comment }) {
  return {
    type: EventType.REPOST,
    to_pubkey: toPubkey,
    post_timestamp: postTimestamp,
    comment: comment || null
  }
}

/**
 * Create a tip event (announces tip without proof)
 * Note: tx_proof intentionally removed for privacy - prevents linking
 * swarm identity to blockchain transactions. Proof stored locally only.
 */
export function createTipEvent({ toSwarmId, postIndex, amount }) {
  return {
    type: EventType.TIP,
    to_swarm_id: toSwarmId,
    post_index: postIndex,
    amount
    // tx_proof removed for privacy - stored locally instead
  }
}

/**
 * Create a tip_received event (author announces tips they received)
 * This makes tips visible to all followers of the author, not just followers of the tipper
 * Note: tx_proof intentionally removed for privacy.
 * @param {number} postTimestamp - Timestamp of the post that was tipped
 * @param {string} fromPubkey - Pubkey of the user who sent the tip (optional, may be unknown)
 * @param {string} amount - Amount in XMR as string
 */
export function createTipReceivedEvent({ postTimestamp, fromPubkey, amount }) {
  return {
    type: EventType.TIP_RECEIVED,
    post_timestamp: postTimestamp,
    from_pubkey: fromPubkey || null,
    amount
    // tx_proof removed for privacy
  }
}

/**
 * Create a delete event (marks a post as deleted)
 */
export function createDeleteEvent({ postTimestamp }) {
  return {
    type: EventType.DELETE,
    post_timestamp: postTimestamp
  }
}

/**
 * Create a discovery profile event
 */
export function createDiscoveryProfileEvent({ tags, tagline, seq, visible = true }) {
  return {
    type: EventType.DISCOVERY_PROFILE,
    seq: seq || 1,
    tags: (tags || []).map(t => t.toLowerCase().replace(/^#/, '')),
    tagline: tagline || null,
    visible
  }
}

/**
 * Create a supporter listing event (paid supporter listing)
 * @param {Array} tags - Array of tags (max 5)
 * @param {string} tagline - Optional tagline description
 * @param {string} txProof - Payment proof (txHash:txKey format)
 * @param {string} amount - XMR amount paid as string
 * @param {number} seq - Sequence number for updates
 * @param {boolean} visible - Whether listing is visible (default true)
 */
export function createSupporterListingEvent({ tags, tagline, txProof, amount, seq, visible = true }) {
  return {
    type: EventType.SUPPORTER_LISTING,
    seq: seq || 1,
    tags: (tags || []).slice(0, 5).map(t => t.toLowerCase().replace(/^#/, '')),
    tagline: tagline || null,
    tx_proof: txProof,
    amount: amount,
    visible
  }
}

/**
 * Create a reply_metadata event (OP announces who replied for thread visibility)
 * This lightweight event allows followers to see that someone replied,
 * even if they don't follow the replier. They can then choose to follow.
 * @param {number} postTimestamp - Timestamp of the post being replied to
 * @param {Object} replier - Info about who replied
 * @param {string} replier.pubkey - Replier's pubkey
 * @param {string} replier.swarmId - Replier's swarm ID
 * @param {string} replier.name - Replier's display name
 * @param {number} replier.replyTimestamp - Timestamp of the reply
 */
export function createReplyMetadataEvent({ postTimestamp, replier }) {
  return {
    type: EventType.REPLY_METADATA,
    post_timestamp: postTimestamp,
    replier: {
      pubkey: replier.pubkey,
      swarm_id: replier.swarmId,
      name: replier.name || '',
      reply_timestamp: replier.replyTimestamp
    }
  }
}

/**
 * Get reply metadata for a specific post
 * @param {Array} events - All events from a feed
 * @param {number} postTimestamp - The post's timestamp
 * @returns {Array} Array of replier info objects
 */
export function getReplyMetadata(events, postTimestamp) {
  return events
    .filter(e => e.type === EventType.REPLY_METADATA && e.post_timestamp === postTimestamp)
    .map(e => e.replier)
}

/**
 * Get all reply metadata from events (for building thread indicators)
 * @param {Array} events - All events from a feed
 * @returns {Map} Map of postTimestamp -> Array of replier info
 */
export function getAllReplyMetadata(events) {
  const metadataByPost = new Map()

  for (const event of events) {
    if (event.type !== EventType.REPLY_METADATA) continue

    const key = event.post_timestamp
    if (!metadataByPost.has(key)) {
      metadataByPost.set(key, [])
    }
    metadataByPost.get(key).push(event.replier)
  }

  return metadataByPost
}

/**
 * Get the latest supporter listing from a list of events
 */
export function getLatestSupporterListing(events) {
  const listingEvents = events.filter(e => e.type === EventType.SUPPORTER_LISTING)
  if (listingEvents.length === 0) return null
  return listingEvents.reduce((latest, e) =>
    (e.seq || 1) > (latest.seq || 1) ? e : latest
  )
}

/**
 * Get the latest profile from a list of events
 */
export function getLatestProfile(events) {
  const profileEvents = events.filter(e => e.type === EventType.PROFILE)
  if (profileEvents.length === 0) return null
  return profileEvents.reduce((latest, e) =>
    e.timestamp > latest.timestamp ? e : latest
  )
}

/**
 * Get the latest discovery profile from a list of events
 */
export function getLatestDiscoveryProfile(events) {
  const discoveryEvents = events.filter(e => e.type === EventType.DISCOVERY_PROFILE)
  if (discoveryEvents.length === 0) return null
  return discoveryEvents.reduce((latest, e) =>
    e.timestamp > latest.timestamp ? e : latest
  )
}

/**
 * Get all posts from a list of events (excluding deleted).
 * DELETE events only suppress posts by the same author (pubkey) to prevent
 * a malicious peer from hiding someone else's post via a colliding timestamp.
 */
export function getPosts(events) {
  const deletedKeys = new Set(
    events
      .filter(e => e.type === EventType.DELETE && e.pubkey)
      .map(e => `${e.pubkey}:${e.post_timestamp}`)
  )
  return events.filter(e =>
    e.type === EventType.POST && !deletedKeys.has(`${e.pubkey}:${e.timestamp}`)
  )
}

/**
 * Get follow list from events (handles follow/unfollow)
 */
export function getFollowing(events) {
  const following = new Set()

  // Process events in order
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  for (const event of sorted) {
    // Support both old feed_key and new swarm_id for backward compatibility
    const id = event.swarm_id || event.feed_key
    if (event.type === EventType.FOLLOW && id) {
      following.add(id)
    } else if (event.type === EventType.UNFOLLOW && id) {
      following.delete(id)
    }
  }

  return Array.from(following)
}

/**
 * Get interaction counts for a post.
 *
 * `likes` is now derived from the reaction aggregator's ❤️ bucket so that
 * legacy `like` events and new `reaction` events with the heart emoji from
 * the same pubkey count as ONE interaction (no double-counting). The
 * `reactions` array carries the full per-emoji breakdown for UI use.
 */
export function getInteractionCounts(events, toPubkey, postTimestamp, opts = {}) {
  let reposts = 0
  let replies = 0

  for (const e of events) {
    if (e.to_pubkey === toPubkey && e.post_timestamp === postTimestamp) {
      if (e.type === EventType.REPOST) reposts++
      else if (e.type === EventType.REPLY) replies++
    }
  }

  const reactions = aggregateReactions(events, toPubkey, postTimestamp, opts)
  const heart = reactions.find(r => r.emoji === LIKE_EMOJI)
  const likes = heart ? heart.count : 0

  return { likes, reposts, replies, reactions }
}

/**
 * Aggregate tips for all posts
 * Returns a Map: "pubkey:timestamp" -> { count, totalAmount }
 */
export function aggregateTips(events, swarmIdToPubkey = {}) {
  const tipsByPost = new Map()

  for (const event of events) {
    if (event.type !== EventType.TIP) continue

    // Resolve swarm ID to pubkey (fallback to swarm ID if not found)
    const pubkey = swarmIdToPubkey[event.to_swarm_id] || event.to_swarm_id

    // Create composite key: pubkey:timestamp
    const postKey = `${pubkey}:${event.post_index}`

    // Initialize or update aggregation
    if (!tipsByPost.has(postKey)) {
      tipsByPost.set(postKey, { count: 0, totalAmount: 0 })
    }

    const current = tipsByPost.get(postKey)
    current.count++

    // Add amounts (stored as XMR string)
    if (event.amount) {
      const amount = parseFloat(event.amount) || 0
      current.totalAmount += amount
    }
  }

  return tipsByPost
}

/**
 * Count tips for all posts with deduplication
 * Counts tips from BOTH `tip` events (from followed users) AND `tip_received` events (from authors)
 * Deduplicates tips that appear in both using tx_proof as unique key
 * Returns a Map: "pubkey:timestamp" -> { count, totalAmount }
 * @param {Array} events - All events from timeline
 * @param {Object} swarmIdToPubkey - Mapping of swarm IDs to pubkeys
 * @param {string} myPubkey - Current user's pubkey (for resolving their own tip_received events)
 */
export function countTipsForPost(events, swarmIdToPubkey = {}, myPubkey = null) {
  const tipsByPost = new Map()
  // Track unique tips by tx_proof to avoid double counting
  // Key: postKey + tx_proof, Value: tip data
  const uniqueTips = new Map()

  for (const event of events) {
    let postKey = null
    let tipKey = null  // Unique key for deduplication
    let amount = 0

    if (event.type === EventType.TIP) {
      // TIP event from tipper's feed
      // Resolve swarm ID to pubkey (fallback to swarm ID if not found)
      const pubkey = swarmIdToPubkey[event.to_swarm_id] || event.to_swarm_id
      postKey = `${pubkey}:${event.post_index}`

      // Use tx_proof as unique key, fallback to amount+timestamp if no tx_proof
      tipKey = event.tx_proof || `${event.amount}:${event.timestamp}`
      amount = parseFloat(event.amount) || 0

    } else if (event.type === EventType.TIP_RECEIVED) {
      // TIP_RECEIVED event from author's feed
      // The author is the one who published this event (event.pubkey)
      postKey = `${event.pubkey}:${event.post_timestamp}`

      // Use tx_proof as unique key, fallback to amount+from_pubkey if no tx_proof
      tipKey = event.tx_proof || `${event.amount}:${event.from_pubkey}`
      amount = parseFloat(event.amount) || 0

    } else {
      continue
    }

    // Deduplicate: only add if we haven't seen this exact tip
    const dedupeKey = `${postKey}:${tipKey}`
    if (uniqueTips.has(dedupeKey)) {
      continue  // Skip duplicate
    }

    uniqueTips.set(dedupeKey, { amount })

    // Initialize or update aggregation
    if (!tipsByPost.has(postKey)) {
      tipsByPost.set(postKey, { count: 0, totalAmount: 0 })
    }

    const current = tipsByPost.get(postKey)
    current.count++
    current.totalAmount += amount
  }

  return tipsByPost
}

/**
 * Check if a user has tipped a post
 */
export function hasTipped(events, userPubkey, toSwarmId, postTimestamp) {
  return events.some(e =>
    e.type === EventType.TIP &&
    e.pubkey === userPubkey &&
    e.to_swarm_id === toSwarmId &&
    e.post_index === postTimestamp
  )
}

/**
 * Build a mapping of subaddress_index -> { pubkey, timestamp }
 * This allows linking wallet transactions to the posts that were tipped
 * Only includes posts from the current user that have subaddress_index set
 * @param {Array} events - All events
 * @param {string} myPubkey - Current user's pubkey
 * @returns {Map} Map of subaddress_index -> { pubkey, timestamp }
 */
export function buildSubaddressToPostMap(events, myPubkey) {
  const map = new Map()

  for (const event of events) {
    // Only process posts from the current user that have a subaddress_index
    if (event.type === EventType.POST &&
        event.pubkey === myPubkey &&
        event.subaddress_index !== null &&
        event.subaddress_index !== undefined) {
      map.set(event.subaddress_index, {
        pubkey: event.pubkey,
        timestamp: event.timestamp
      })
    }
  }

  return map
}

/**
 * Check if a user has liked a post. Returns true for either a legacy `like`
 * event or a `reaction` event with the canonical heart emoji.
 */
export function hasLiked(events, userPubkey, toPubkey, postTimestamp) {
  return events.some(e => {
    if (e.pubkey !== userPubkey) return false
    if (e.to_pubkey !== toPubkey) return false
    if (e.post_timestamp !== postTimestamp) return false
    if (e.type === EventType.LIKE) return true
    if (e.type === EventType.REACTION && e.emoji === LIKE_EMOJI) return true
    return false
  })
}

/**
 * Check if a user has reposted a post
 */
export function hasReposted(events, userPubkey, toPubkey, postTimestamp) {
  return events.some(e =>
    e.type === EventType.REPOST &&
    e.pubkey === userPubkey &&
    e.to_pubkey === toPubkey &&
    e.post_timestamp === postTimestamp
  )
}

/**
 * Get replies to a specific post/reply
 */
export function getReplies(events, toPubkey, postTimestamp) {
  return events.filter(e =>
    e.type === EventType.REPLY &&
    e.to_pubkey === toPubkey &&
    e.post_timestamp === postTimestamp
  ).sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Get all replies in a thread (including nested replies) as a flat list
 * Returns replies sorted by timestamp, with depth indicator
 */
export function getAllRepliesFlat(events, rootPubkey, rootTimestamp, deletedKeys = null) {
  // Build set of deleted {pubkey}:{post_timestamp} keys if not provided.
  // Keyed by author so one peer cannot suppress another peer's reply via a
  // colliding timestamp.
  if (!deletedKeys) {
    deletedKeys = new Set(
      events
        .filter(e => e.type === EventType.DELETE && e.pubkey)
        .map(e => `${e.pubkey}:${Number(e.post_timestamp)}`)
    )
  }

  const allReplies = []

  function collectReplies(toPubkey, postTimestamp, depth) {
    const replies = events.filter(e =>
      e.type === EventType.REPLY &&
      e.to_pubkey === toPubkey &&
      Number(e.post_timestamp) === Number(postTimestamp) &&
      !deletedKeys.has(`${e.pubkey}:${Number(e.timestamp)}`)
    )

    for (const reply of replies) {
      allReplies.push({ ...reply, _depth: depth, _parentPubkey: toPubkey, _parentTimestamp: postTimestamp })
      // Recursively get replies to this reply
      collectReplies(reply.pubkey, reply.timestamp, depth + 1)
    }
  }

  collectReplies(rootPubkey, rootTimestamp, 0)

  // Sort by timestamp
  return allReplies.sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Build a thread tree starting from a root post
 */
export function buildThread(events, rootPubkey, rootTimestamp) {
  // Ensure timestamp is a number for comparison
  const targetTimestamp = Number(rootTimestamp)

  // Keyed by author so one peer cannot suppress another peer's post/reply
  // via a colliding timestamp.
  const deletedKeys = new Set(
    events
      .filter(e => e.type === EventType.DELETE && e.pubkey)
      .map(e => `${e.pubkey}:${Number(e.post_timestamp)}`)
  )

  // Find the root post
  const root = events.find(e =>
    (e.type === EventType.POST || e.type === EventType.REPLY) &&
    e.pubkey === rootPubkey &&
    Number(e.timestamp) === targetTimestamp &&
    !deletedKeys.has(`${e.pubkey}:${Number(e.timestamp)}`)
  )

  if (!root) return null

  // Recursive function to get replies
  function getNestedReplies(pubkey, timestamp) {
    const targetTs = Number(timestamp)
    const replies = events.filter(e =>
      e.type === EventType.REPLY &&
      e.to_pubkey === pubkey &&
      Number(e.post_timestamp) === targetTs &&
      !deletedKeys.has(`${e.pubkey}:${Number(e.timestamp)}`)
    ).sort((a, b) => Number(a.timestamp) - Number(b.timestamp))

    return replies.map(reply => ({
      ...reply,
      replies: getNestedReplies(reply.pubkey, reply.timestamp)
    }))
  }

  return {
    ...root,
    replies: getNestedReplies(root.pubkey, root.timestamp)
  }
}
