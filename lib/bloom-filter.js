/**
 * Simple Bloom Filter implementation for efficient gossip protocol
 * Used for checking "do I have this profile pubkey" with minimal bandwidth
 *
 * A 1KB filter (8192 bits) with 3 hash functions can handle ~1000 items
 * with approximately <1% false positive rate
 */

class BloomFilter {
  /**
   * Create a new Bloom Filter
   * @param {number} size - Size of the filter in bytes (default 1024 = 1KB)
   * @param {number} hashCount - Number of hash functions to use (default 3)
   */
  constructor(size = 1024, hashCount = 3) {
    this.size = size;
    this.hashCount = hashCount;
    this.bitArray = new Uint8Array(size);
  }

  /**
   * DJB2 hash function - simple and fast string hashing
   * @param {string} str - String to hash
   * @param {number} seed - Seed value for generating different hashes
   * @returns {number} Hash value
   */
  _hash(str, seed) {
    let hash = 5381 + seed;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
      hash = hash >>> 0; // Convert to unsigned 32-bit integer
    }
    return hash;
  }

  /**
   * Get bit positions for an item using multiple hash functions
   * @param {string} item - Item to hash
   * @returns {number[]} Array of bit positions
   */
  _getPositions(item) {
    const positions = [];
    const totalBits = this.size * 8;

    for (let i = 0; i < this.hashCount; i++) {
      const hash = this._hash(item, i * 0xDEADBEEF);
      positions.push(hash % totalBits);
    }

    return positions;
  }

  /**
   * Set a bit at a specific position
   * @param {number} position - Bit position to set
   */
  _setBit(position) {
    const byteIndex = Math.floor(position / 8);
    const bitIndex = position % 8;
    this.bitArray[byteIndex] |= (1 << bitIndex);
  }

  /**
   * Get a bit at a specific position
   * @param {number} position - Bit position to check
   * @returns {boolean} True if bit is set
   */
  _getBit(position) {
    const byteIndex = Math.floor(position / 8);
    const bitIndex = position % 8;
    return (this.bitArray[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Add an item (pubkey) to the filter
   * @param {string} item - String to add to the filter
   */
  add(item) {
    const positions = this._getPositions(item);
    for (const pos of positions) {
      this._setBit(pos);
    }
  }

  /**
   * Check if an item might be in the filter
   * Note: May return false positives, but never false negatives
   * @param {string} item - String to check
   * @returns {boolean} True if item might be in filter, false if definitely not
   */
  mightContain(item) {
    const positions = this._getPositions(item);
    for (const pos of positions) {
      if (!this._getBit(pos)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Serialize the bloom filter to a Uint8Array for transmission
   * Format: [size (4 bytes)] [hashCount (1 byte)] [bitArray]
   * @returns {Uint8Array} Serialized filter
   */
  toBuffer() {
    const buffer = new Uint8Array(5 + this.size);

    // Write size as 4 bytes (big-endian)
    buffer[0] = (this.size >> 24) & 0xFF;
    buffer[1] = (this.size >> 16) & 0xFF;
    buffer[2] = (this.size >> 8) & 0xFF;
    buffer[3] = this.size & 0xFF;

    // Write hashCount as 1 byte
    buffer[4] = this.hashCount;

    // Copy bitArray
    buffer.set(this.bitArray, 5);

    return buffer;
  }

  /**
   * Deserialize a bloom filter from a buffer.
   * Caps size and hashCount so a malicious peer cannot allocate arbitrary
   * memory or amplify CPU via huge hashCount values.
   * @param {Uint8Array} buf - Serialized filter buffer
   * @returns {BloomFilter} Deserialized bloom filter
   */
  static fromBuffer(buf) {
    const MAX_SIZE = 8192;   // 8 KB max filter body
    const MAX_HASH_COUNT = 8;

    if (buf.length < 6) {
      throw new Error('Invalid bloom filter buffer: too short');
    }

    const size = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    const hashCount = buf[4];

    if (size <= 0 || size > MAX_SIZE) {
      throw new Error(`Invalid bloom filter size: ${size} (max ${MAX_SIZE})`);
    }
    if (hashCount <= 0 || hashCount > MAX_HASH_COUNT) {
      throw new Error(`Invalid bloom filter hashCount: ${hashCount} (max ${MAX_HASH_COUNT})`);
    }
    if (buf.length !== 5 + size) {
      throw new Error(`Invalid bloom filter buffer: expected ${5 + size} bytes, got ${buf.length}`);
    }

    const filter = new BloomFilter(size, hashCount);
    filter.bitArray.set(buf.slice(5));

    return filter;
  }
}

export default BloomFilter;
