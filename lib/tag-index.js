/**
 * Tag Index - Indexes posts by hashtag for search and trending
 *
 * Stores mapping of tag -> array of post references
 * with persistence to disk.
 */

import fs from 'fs'
import path from 'path'

/**
 * TagIndex class
 * Indexes posts by hashtag for efficient tag-based search
 */
export class TagIndex {
  constructor() {
    // Map of tag -> array of { pubkey, timestamp, source }
    // source can be 'own', 'following', or 'fof' (friend-of-friend)
    this.index = new Map()
    // Map of "pubkey:timestamp" -> content (stored separately to avoid duplication)
    this.contentStore = new Map()
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
   * Get the index file path
   * @returns {string}
   */
  _getIndexPath() {
    if (!this.dataDir) {
      throw new Error('Data directory not set')
    }
    return path.join(this.dataDir, 'tag-index.json')
  }

  /**
   * Get the content store file path
   * @returns {string}
   */
  _getContentPath() {
    if (!this.dataDir) {
      throw new Error('Data directory not set')
    }
    return path.join(this.dataDir, 'tag-content.json')
  }

  /**
   * Load index from storage
   */
  load() {
    // Always clear existing data when loading (prevents data leakage between accounts)
    this.index = new Map()
    this.contentStore = new Map()

    if (!this.dataDir) {
      console.warn('[TagIndex] Data directory not set, skipping load')
      return
    }

    const indexPath = this._getIndexPath()
    const contentPath = this._getContentPath()

    // Load tag index
    if (fs.existsSync(indexPath)) {
      try {
        const content = fs.readFileSync(indexPath, 'utf8')
        const data = JSON.parse(content)

        for (const [tag, posts] of Object.entries(data)) {
          this.index.set(tag, posts)
        }

        console.log('[TagIndex] Loaded index with', this.index.size, 'tags')
      } catch (e) {
        console.error('[TagIndex] Error loading index:', e.message)
      }
    } else {
      console.log('[TagIndex] No index file found, starting fresh')
    }

    // Load content store
    if (fs.existsSync(contentPath)) {
      try {
        const content = fs.readFileSync(contentPath, 'utf8')
        const data = JSON.parse(content)

        for (const [key, text] of Object.entries(data)) {
          this.contentStore.set(key, text)
        }

        console.log('[TagIndex] Loaded content store with', this.contentStore.size, 'posts')
      } catch (e) {
        console.error('[TagIndex] Error loading content store:', e.message)
      }
    }
  }

  /**
   * Save index to storage
   */
  save() {
    if (!this.dataDir) {
      console.warn('[TagIndex] Data directory not set, skipping save')
      return
    }

    try {
      // Ensure data directory exists
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true })
      }

      // Convert tag index Map to object for JSON serialization
      const indexData = {}
      for (const [tag, posts] of this.index.entries()) {
        indexData[tag] = posts
      }

      const indexPath = this._getIndexPath()
      fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8')

      // Convert content store Map to object for JSON serialization
      const contentData = {}
      for (const [key, text] of this.contentStore.entries()) {
        contentData[key] = text
      }

      const contentPath = this._getContentPath()
      fs.writeFileSync(contentPath, JSON.stringify(contentData), 'utf8')

      console.log('[TagIndex] Saved index with', this.index.size, 'tags,', this.contentStore.size, 'posts')
    } catch (e) {
      console.error('[TagIndex] Error saving index:', e.message)
    }
  }

  /**
   * Index a post by its tags
   * @param {Object} post - Post object with { pubkey, timestamp, tags, source, content }
   *   - pubkey: Hex-encoded public key of the post author
   *   - timestamp: Post timestamp
   *   - tags: Array of lowercase tags (without #)
   *   - source: 'own', 'following', or 'fof'
   *   - content: Post text content (optional, for search results display)
   * @param {boolean} autoSave - Whether to auto-save after indexing (default: true)
   * @returns {boolean} True if post was indexed (had tags and wasn't a duplicate)
   */
  indexPost(post, autoSave = true) {
    if (!post || !post.pubkey || !post.timestamp) {
      return false
    }

    const tags = post.tags || []
    if (tags.length === 0) {
      return false
    }

    const source = post.source || 'following'
    const postRef = {
      pubkey: post.pubkey,
      timestamp: post.timestamp,
      source
    }

    // Include swarmId for FoF posts (enables "Retrieve Conversation")
    if (post.authorSwarmId) {
      postRef.swarmId = post.authorSwarmId
    } else if (post.swarmId) {
      postRef.swarmId = post.swarmId
    }

    // Store content separately (keyed by pubkey:timestamp to avoid duplication)
    const contentKey = `${post.pubkey}:${post.timestamp}`
    if (post.content && !this.contentStore.has(contentKey)) {
      this.contentStore.set(contentKey, post.content)
    }

    let indexed = false
    for (const tag of tags) {
      // Normalize tag to lowercase
      const normalizedTag = tag.toLowerCase()

      if (!this.index.has(normalizedTag)) {
        this.index.set(normalizedTag, [])
      }

      const posts = this.index.get(normalizedTag)

      // Check for duplicates (same pubkey + timestamp)
      const isDuplicate = posts.some(
        p => p.pubkey === postRef.pubkey && p.timestamp === postRef.timestamp
      )

      if (!isDuplicate) {
        posts.push(postRef)
        indexed = true
      }
    }

    // Auto-save after indexing (can be disabled for batch operations)
    if (autoSave && indexed) {
      this.save()
    }

    return indexed
  }

  /**
   * Index multiple posts in batch (more efficient than individual indexPost calls)
   * @param {Array} posts - Array of post objects
   * @param {string} source - Source for all posts ('own', 'following', or 'fof')
   * @returns {number} Number of posts indexed
   */
  indexPostsBatch(posts, source = 'following') {
    let count = 0
    for (const post of posts) {
      // Add source to each post and index without auto-save
      const postWithSource = { ...post, source }
      if (this.indexPost(postWithSource, false)) {
        count++
      }
    }

    // Save once after batch
    if (count > 0) {
      this.save()
    }

    return count
  }

  /**
   * Search for posts by tag
   * @param {string} tag - Tag to search for (with or without #)
   * @returns {Array} Array of { pubkey, timestamp, source, content } sorted by timestamp (newest first)
   */
  search(tag) {
    if (!tag || typeof tag !== 'string') {
      return []
    }

    // Normalize: remove # prefix if present, lowercase
    const normalizedTag = tag.toLowerCase().replace(/^#/, '')

    const posts = this.index.get(normalizedTag) || []

    // Return sorted by timestamp (newest first), with content attached
    return [...posts]
      .sort((a, b) => b.timestamp - a.timestamp)
      .map(post => ({
        ...post,
        content: this.getContent(post.pubkey, post.timestamp)
      }))
  }

  /**
   * Get content for a specific post
   * @param {string} pubkey - Post author's pubkey
   * @param {number} timestamp - Post timestamp
   * @returns {string|null} Post content or null if not found
   */
  getContent(pubkey, timestamp) {
    const key = `${pubkey}:${timestamp}`
    return this.contentStore.get(key) || null
  }

  /**
   * Get trending tags sorted by post count
   * @param {number} limit - Maximum number of tags to return (default 10)
   * @returns {Array} Array of { tag, count } sorted by count (highest first)
   */
  getTrending(limit = 10) {
    const tagCounts = []

    for (const [tag, posts] of this.index.entries()) {
      tagCounts.push({
        tag,
        count: posts.length
      })
    }

    // Sort by count descending, then alphabetically for ties
    tagCounts.sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count
      }
      return a.tag.localeCompare(b.tag)
    })

    return tagCounts.slice(0, limit)
  }

  /**
   * Clear all indexed data
   */
  clear() {
    this.index = new Map()
    this.contentStore = new Map()
    this.save()
    console.log('[TagIndex] Cleared all indexed data')
  }
}

// Singleton instance for convenience
let defaultTagIndex = null

/**
 * Get or create the default TagIndex instance
 * @returns {TagIndex}
 */
export function getTagIndex() {
  if (!defaultTagIndex) {
    defaultTagIndex = new TagIndex()
  }
  return defaultTagIndex
}
