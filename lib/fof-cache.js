/**
 * Friend-of-Friend post cache
 * Caches posts from users we don't directly follow but discover through followed users
 * Uses FIFO eviction when cache exceeds max size
 */

import fs from 'fs'
import path from 'path'

const DEFAULT_MAX_SIZE = 1000

export class FoFCache {
  /**
   * Create a new FoF cache
   * @param {string} dataDir - Data directory for persistence
   * @param {Object} options - Configuration options
   * @param {number} options.maxSize - Maximum number of posts to cache (default: 1000)
   * @param {string} options.pubkeyHex - Account pubkey. Used to scope the cache
   *                                      file so accounts don't share a single
   *                                      `fof-cache.json`.
   */
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir
    this.maxSize = options.maxSize || DEFAULT_MAX_SIZE
    this.cachePath = path.join(dataDir, options.pubkeyHex ? `fof-cache-${options.pubkeyHex}.json` : 'fof-cache.json')

    // Posts stored as array for FIFO ordering (oldest first)
    // Each post has: original post data + viaSwarmId + cachedAt
    this.posts = []

    // Index for fast lookups by pubkey+timestamp
    this.postIndex = new Map() // "pubkey:timestamp" -> array index

    // Index for tag lookups
    this.tagIndex = new Map() // tag -> Set of "pubkey:timestamp" keys

    // Load from disk
    this._load()
  }

  /**
   * Generate a unique key for a post
   */
  _postKey(pubkey, timestamp) {
    return `${pubkey}:${timestamp}`
  }

  /**
   * Load cache from disk
   */
  _load() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'))

        if (data.version === 1 && Array.isArray(data.posts)) {
          this.posts = data.posts
          this._rebuildIndexes()
          console.log(`[FoFCache] Loaded ${this.posts.length} cached posts`)
        }
      }
    } catch (err) {
      console.warn('[FoFCache] Error loading cache:', err.message)
      this.posts = []
      this._rebuildIndexes()
    }
  }

  /**
   * Save cache to disk
   */
  _save() {
    try {
      // Ensure data directory exists
      fs.mkdirSync(this.dataDir, { recursive: true })

      const data = {
        version: 1,
        savedAt: Date.now(),
        maxSize: this.maxSize,
        posts: this.posts
      }

      fs.writeFileSync(this.cachePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.warn('[FoFCache] Error saving cache:', err.message)
    }
  }

  /**
   * Rebuild indexes from posts array
   */
  _rebuildIndexes() {
    this.postIndex.clear()
    this.tagIndex.clear()

    for (let i = 0; i < this.posts.length; i++) {
      const post = this.posts[i]
      const key = this._postKey(post.pubkey, post.timestamp)
      this.postIndex.set(key, i)

      // Index tags
      if (Array.isArray(post.tags)) {
        for (const tag of post.tags) {
          if (!this.tagIndex.has(tag)) {
            this.tagIndex.set(tag, new Set())
          }
          this.tagIndex.get(tag).add(key)
        }
      }
    }
  }

  /**
   * Add a FoF post to the cache
   * @param {Object} post - The post object (pubkey, timestamp, content, tags, media, etc.)
   * @param {string} viaSwarmId - Swarm ID of the user we discovered this post through
   * @returns {Object} The cached post with viaSwarmId and cachedAt added
   */
  add(post, viaSwarmId) {
    if (!post || !post.pubkey || !post.timestamp) {
      console.warn('[FoFCache] Invalid post: missing pubkey or timestamp')
      return null
    }

    const key = this._postKey(post.pubkey, post.timestamp)

    // Check if post already exists
    if (this.postIndex.has(key)) {
      // Update existing post's viaSwarmId if this is a new source
      const index = this.postIndex.get(key)
      const existing = this.posts[index]
      // Don't update if already cached
      return existing
    }

    // Create cached post with attribution
    const cachedPost = {
      ...post,
      viaSwarmId,
      cachedAt: Date.now()
    }

    // Add to end of array (newest)
    const newIndex = this.posts.length
    this.posts.push(cachedPost)
    this.postIndex.set(key, newIndex)

    // Index tags
    if (Array.isArray(post.tags)) {
      for (const tag of post.tags) {
        if (!this.tagIndex.has(tag)) {
          this.tagIndex.set(tag, new Set())
        }
        this.tagIndex.get(tag).add(key)
      }
    }

    // Evict oldest if over limit
    if (this.posts.length > this.maxSize) {
      this.evict()
    }

    // Save to disk
    this._save()

    return cachedPost
  }

  /**
   * Get a specific post by pubkey and timestamp
   * @param {string} pubkey - Post author's public key
   * @param {number} timestamp - Post timestamp
   * @returns {Object|null} The cached post or null if not found
   */
  get(pubkey, timestamp) {
    const key = this._postKey(pubkey, timestamp)
    const index = this.postIndex.get(key)

    if (index !== undefined && index < this.posts.length) {
      return this.posts[index]
    }

    return null
  }

  /**
   * Get all posts with a specific tag
   * @param {string} tag - The tag to search for
   * @returns {Array} Array of posts with the specified tag
   */
  getByTag(tag) {
    const keys = this.tagIndex.get(tag)
    if (!keys || keys.size === 0) {
      return []
    }

    const posts = []
    for (const key of keys) {
      const index = this.postIndex.get(key)
      if (index !== undefined && index < this.posts.length) {
        posts.push(this.posts[index])
      }
    }

    // Sort by timestamp, newest first
    posts.sort((a, b) => b.timestamp - a.timestamp)

    return posts
  }

  /**
   * Get all cached posts
   * @returns {Array} Array of all cached posts, sorted by timestamp (newest first)
   */
  getAll() {
    // Return a copy sorted by timestamp, newest first
    return [...this.posts].sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Evict oldest posts to bring cache under max size
   * Uses FIFO: removes posts from the beginning of the array (oldest cached)
   */
  evict() {
    if (this.posts.length <= this.maxSize) {
      return
    }

    const toRemove = this.posts.length - this.maxSize

    // Remove oldest posts (from beginning of array)
    const removed = this.posts.splice(0, toRemove)

    // Update indexes for removed posts
    for (const post of removed) {
      const key = this._postKey(post.pubkey, post.timestamp)
      this.postIndex.delete(key)

      // Remove from tag index
      if (Array.isArray(post.tags)) {
        for (const tag of post.tags) {
          const tagSet = this.tagIndex.get(tag)
          if (tagSet) {
            tagSet.delete(key)
            if (tagSet.size === 0) {
              this.tagIndex.delete(tag)
            }
          }
        }
      }
    }

    // Rebuild post index with new positions
    this._rebuildIndexes()

    console.log(`[FoFCache] Evicted ${toRemove} oldest posts`)
  }

  /**
   * Clear all cached posts
   */
  clear() {
    this.posts = []
    this.postIndex.clear()
    this.tagIndex.clear()
    this._save()
    console.log('[FoFCache] Cache cleared')
  }

  /**
   * Update the maximum cache size
   * Will trigger eviction if current size exceeds new max
   * @param {number} size - New maximum size
   */
  setMaxSize(size) {
    if (typeof size !== 'number' || size < 1) {
      throw new Error('Max size must be a positive number')
    }

    this.maxSize = size

    // Evict if necessary
    if (this.posts.length > this.maxSize) {
      this.evict()
      this._save()
    }

    console.log(`[FoFCache] Max size set to ${size}`)
  }

  /**
   * Get cache statistics
   * @returns {Object} {count, maxSize, oldestTimestamp}
   */
  getStats() {
    let oldestTimestamp = null

    if (this.posts.length > 0) {
      // Oldest is at the beginning due to FIFO ordering
      oldestTimestamp = this.posts[0].cachedAt
    }

    return {
      count: this.posts.length,
      maxSize: this.maxSize,
      oldestTimestamp
    }
  }
}
