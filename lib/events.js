/**
 * Event types for Swarmnero social network
 *
 * All events are appended to user's Hypercore feed.
 * Signature and timestamp are added by the Feed class.
 */

import { extractHashtags } from './tag-extractor.js'
import { verifyEventSignature } from './feed.js'

// Hard cap on attachments per post/reply. Enforced at compose AND ingest.
export const MAX_MEDIA_PER_POST = 10
// Per-element size ceiling, mirrors the existing peer-file cap.
export const MAX_MEDIA_ITEM_BYTES = 25 * 1024 * 1024
// Allow-list of path prefixes on the peer Hyperdrive. Any other prefix is
// rejected at ingest (matches lib/media.js SAFE_PATH_PREFIXES).
const MEDIA_PATH_PREFIXES = ['/images/', '/videos/', '/files/']

// Hard cap on reply recursion depth. Enforced at parser layer (buildThread and
// getAllRepliesFlat) regardless of any UI-layer collapse setting. Prevents a
// malicious chain of self-replies from exploding memory / CPU when we traverse
// a thread. UI render-collapse (default depth 3 + expand stub) is a separate
// layer on top of this hard cap.
export const MAX_REPLY_DEPTH = 64

// Max length of the optional content-warning label. Enforced on compose AND
// ingest — posts whose cw field exceeds this are rejected at ingest time.
export const MAX_CW_LENGTH = 200

function isSafeMediaPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false
  if (p.includes('\0') || p.includes('..')) return false
  return MEDIA_PATH_PREFIXES.some(prefix => p.startsWith(prefix))
}

function isValidMediaItem(m) {
  if (!m || typeof m !== 'object') return false
  if (typeof m.driveKey !== 'string' || !/^[a-f0-9]{64}$/i.test(m.driveKey)) return false
  if (!isSafeMediaPath(m.path)) return false
  if (m.thumb !== undefined && m.thumb !== null) {
    if (typeof m.thumb !== 'string') return false
    if (m.thumb.length > 128 * 1024) return false
    if (!m.thumb.startsWith('data:image/')) return false
  }
  if (typeof m.size === 'number' && m.size > MAX_MEDIA_ITEM_BYTES) return false
  return true
}

export function sanitizeMediaArray(media) {
  if (!Array.isArray(media)) return []
  const out = []
  for (const m of media) {
    if (out.length >= MAX_MEDIA_PER_POST) break
    if (isValidMediaItem(m)) out.push(m)
  }
  return out
}

export const EventType = {
  PROFILE: 'profile',
  POST: 'post',
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
  REPLY: 'reply',
  LIKE: 'like',
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
  // Poll event types
  POLL: 'poll',
  POLL_VOTE: 'poll_vote',
  // DM event types (stored in DM cores, not public feed)
  DM_MESSAGE: 'dm_message',
  DM_MEDIA: 'dm_media',
  DM_READ: 'dm_read'
}

/** Bounds for poll events — mirrored on compose and ingest validation. */
export const POLL_MAX_OPTIONS = 10
export const POLL_MAX_OPTION_LEN = 100
/** Ingest-side clock skew tolerance for future-timestamped poll votes. */
export const POLL_VOTE_FUTURE_SKEW_MS = 5 * 60 * 1000

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
  paywallSubaddressIndex,
  cw
}) {
  const event = {
    type: EventType.POST,
    content,
    tags: extractHashtags(content || ''),
    media: Array.isArray(media) ? media.slice(0, MAX_MEDIA_PER_POST) : [],
    subaddress: subaddress || null,
    subaddress_index: subaddressIndex || null
  }

  if (typeof cw === 'string') {
    const trimmed = cw.trim()
    if (trimmed.length > 0 && trimmed.length <= MAX_CW_LENGTH) {
      event.cw = trimmed
    }
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
 * Validate a post event's cw field on ingest. Drops events whose cw exceeds
 * the cap or is non-string. Returns true if the event is acceptable.
 */
export function isValidPostCw(event) {
  if (!event || event.type !== EventType.POST) return true
  if (event.cw === undefined || event.cw === null) return true
  if (typeof event.cw !== 'string') return false
  if (event.cw.length > MAX_CW_LENGTH) return false
  return true
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
    media: Array.isArray(media) ? media.slice(0, MAX_MEDIA_PER_POST) : []
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
 * Create a poll event (the question + options).
 *
 * `expiresAt` is a millisecond timestamp. `options` is an array of plain-text
 * labels. Bounds (count + per-option length) are enforced here AND re-checked
 * on ingest so a malformed peer event is dropped in the aggregator.
 */
export function createPollEvent({ question, options, expiresAt }) {
  if (!Array.isArray(options)) throw new Error('Poll options must be an array')
  const cleaned = options
    .map(o => (typeof o === 'string' ? o.trim() : ''))
    .filter(o => o.length > 0)
  if (cleaned.length < 2) throw new Error('Poll must have at least 2 options')
  if (cleaned.length > POLL_MAX_OPTIONS) {
    throw new Error(`Poll options capped at ${POLL_MAX_OPTIONS}`)
  }
  for (const label of cleaned) {
    if (label.length > POLL_MAX_OPTION_LEN) {
      throw new Error(`Poll option exceeds ${POLL_MAX_OPTION_LEN} chars`)
    }
  }
  const expires = Number(expiresAt)
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    throw new Error('Poll expires_at must be a future timestamp')
  }
  return {
    type: EventType.POLL,
    question: typeof question === 'string' ? question.trim().slice(0, 280) : '',
    options: cleaned,
    expires_at: expires
  }
}

/**
 * Create a poll_vote event. `pollAuthorPubkey` + `pollTimestamp` pick a poll
 * uniquely (its author's feed + the signed creation timestamp).
 */
export function createPollVoteEvent({ pollAuthorPubkey, pollTimestamp, optionIndex }) {
  if (typeof pollAuthorPubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(pollAuthorPubkey)) {
    throw new Error('Invalid poll author pubkey')
  }
  if (!Number.isFinite(Number(pollTimestamp))) {
    throw new Error('Invalid poll timestamp')
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0) {
    throw new Error('Invalid option_index')
  }
  return {
    type: EventType.POLL_VOTE,
    poll_author: pollAuthorPubkey.toLowerCase(),
    poll_timestamp: Number(pollTimestamp),
    option_index: optionIndex
  }
}

/**
 * Shape-check a poll event (used both during ingest and before render).
 * Returns true if the event is structurally valid. Does NOT check signature —
 * callers must run verifyEventSignature separately.
 */
export function validatePollEvent(event) {
  if (!event || event.type !== EventType.POLL) return false
  if (typeof event.pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(event.pubkey)) return false
  if (!Number.isFinite(Number(event.timestamp))) return false
  if (!Number.isFinite(Number(event.expires_at))) return false
  if (!Array.isArray(event.options)) return false
  if (event.options.length < 2 || event.options.length > POLL_MAX_OPTIONS) return false
  for (const opt of event.options) {
    if (typeof opt !== 'string' || opt.length === 0 || opt.length > POLL_MAX_OPTION_LEN) {
      return false
    }
  }
  return true
}

/**
 * Shape-check a poll_vote event relative to a poll. Rejects malformed vote
 * structure, out-of-bounds option indices, and future-dated timestamps beyond
 * a small skew tolerance. Does NOT check signature — callers must run
 * verifyEventSignature separately (see `tallyPollVotes`).
 */
export function validatePollVoteEvent(vote, poll, nowMs = Date.now()) {
  if (!vote || vote.type !== EventType.POLL_VOTE) return false
  if (typeof vote.pubkey !== 'string' || !/^[a-f0-9]{64}$/i.test(vote.pubkey)) return false
  if (typeof vote.poll_author !== 'string' || vote.poll_author.toLowerCase() !== poll.pubkey.toLowerCase()) return false
  if (Number(vote.poll_timestamp) !== Number(poll.timestamp)) return false
  if (!Number.isInteger(vote.option_index)) return false
  if (vote.option_index < 0 || vote.option_index >= poll.options.length) return false
  if (!Number.isFinite(Number(vote.timestamp))) return false
  if (Number(vote.timestamp) > nowMs + POLL_VOTE_FUTURE_SKEW_MS) return false
  return true
}

/**
 * Tally votes for a poll.
 *
 * Dedupe rule: one vote per voter pubkey. Latest `timestamp` wins; ties are
 * broken by Hypercore sequence number (`_seq`, attached at read time by
 * `feed.read` / `feed.readPeer` / `feed.getTimeline`). Timestamps alone are
 * attacker-controllable at compose time but are signed into the event by
 * `feed.append`; the aggregator never trusts wall-clock ordering.
 *
 * Votes are counted only if:
 *   - the vote event passes `verifyEventSignature`
 *   - the vote's structure passes `validatePollVoteEvent`
 *   - `vote.timestamp <= poll.expires_at`
 *
 * Returns `{ counts: number[], total: number, voters: Map<pubkey, optionIndex> }`
 * where `counts[i]` is the tally for `poll.options[i]`.
 */
export function tallyPollVotes(poll, events, nowMs = Date.now()) {
  const counts = new Array(poll.options.length).fill(0)
  const voters = new Map()
  if (!poll || !Array.isArray(events)) {
    return { counts, total: 0, voters }
  }
  if (!validatePollEvent(poll)) {
    return { counts, total: 0, voters }
  }

  // Collect one latest vote per voter. Use both the signed timestamp and the
  // Hypercore sequence number so two votes with the same wall-clock time
  // resolve deterministically to the later feed position.
  const latestByVoter = new Map()
  for (const ev of events) {
    if (!ev || ev.type !== EventType.POLL_VOTE) continue
    if (!validatePollVoteEvent(ev, poll, nowMs)) continue
    if (Number(ev.timestamp) > Number(poll.expires_at)) continue
    if (!verifyEventSignature(ev)) continue

    const voter = ev.pubkey.toLowerCase()
    const existing = latestByVoter.get(voter)
    if (!existing) {
      latestByVoter.set(voter, ev)
      continue
    }
    const exTs = Number(existing.timestamp)
    const evTs = Number(ev.timestamp)
    if (evTs > exTs) {
      latestByVoter.set(voter, ev)
    } else if (evTs === exTs) {
      const exSeq = Number.isFinite(Number(existing._seq)) ? Number(existing._seq) : -1
      const evSeq = Number.isFinite(Number(ev._seq)) ? Number(ev._seq) : -1
      if (evSeq > exSeq) latestByVoter.set(voter, ev)
    }
  }

  let total = 0
  for (const [voter, ev] of latestByVoter) {
    counts[ev.option_index]++
    voters.set(voter, ev.option_index)
    total++
  }
  return { counts, total, voters }
}

/**
 * Find a poll by (author_pubkey, timestamp) in an event stream.
 * Returns the structurally-valid poll event or null.
 */
export function findPoll(events, authorPubkey, timestamp) {
  if (!Array.isArray(events)) return null
  const ts = Number(timestamp)
  const author = (authorPubkey || '').toLowerCase()
  for (const ev of events) {
    if (!ev || ev.type !== EventType.POLL) continue
    if ((ev.pubkey || '').toLowerCase() !== author) continue
    if (Number(ev.timestamp) !== ts) continue
    if (!validatePollEvent(ev)) return null
    return ev
  }
  return null
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
 * Get interaction counts for a post
 */
export function getInteractionCounts(events, toPubkey, postTimestamp) {
  let likes = 0
  let reposts = 0
  let replies = 0

  for (const e of events) {
    if (e.to_pubkey === toPubkey && e.post_timestamp === postTimestamp) {
      if (e.type === EventType.LIKE) likes++
      else if (e.type === EventType.REPOST) reposts++
      else if (e.type === EventType.REPLY) replies++
    }
  }

  return { likes, reposts, replies }
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
 * Check if a user has liked a post
 */
export function hasLiked(events, userPubkey, toPubkey, postTimestamp) {
  return events.some(e =>
    e.type === EventType.LIKE &&
    e.pubkey === userPubkey &&
    e.to_pubkey === toPubkey &&
    e.post_timestamp === postTimestamp
  )
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
    // Hard cap: stop descending past MAX_REPLY_DEPTH regardless of UI.
    // DoS protection — a malicious chain of self-replies must not blow the
    // stack or eat unbounded memory.
    if (depth >= MAX_REPLY_DEPTH) return

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

  // Recursive function to get replies. Hard-capped at MAX_REPLY_DEPTH
  // regardless of UI collapse depth — parser-layer DoS protection.
  function getNestedReplies(pubkey, timestamp, depth) {
    if (depth >= MAX_REPLY_DEPTH) return []

    const targetTs = Number(timestamp)
    const replies = events.filter(e =>
      e.type === EventType.REPLY &&
      e.to_pubkey === pubkey &&
      Number(e.post_timestamp) === targetTs &&
      !deletedKeys.has(`${e.pubkey}:${Number(e.timestamp)}`)
    ).sort((a, b) => Number(a.timestamp) - Number(b.timestamp))

    return replies.map(reply => ({
      ...reply,
      replies: getNestedReplies(reply.pubkey, reply.timestamp, depth + 1)
    }))
  }

  return {
    ...root,
    replies: getNestedReplies(root.pubkey, root.timestamp, 1)
  }
}
