/**
 * Encrypted wallet persistence
 * Uses same sodium encryption pattern as accounts.js (argon2id + secretbox)
 */

import sodium from 'sodium-native'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'

/**
 * Validate account name to prevent path traversal attacks
 */
function validateAccountName(name) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Invalid account name: must contain only letters, numbers, underscores, and hyphens')
  }
}

/**
 * Get wallets directory path
 */
function getWalletsDir(dataDir) {
  return path.join(dataDir, 'wallets')
}

/**
 * Get wallet file path
 */
function getWalletPath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.json`)
}

/**
 * Get wallet cache file path
 */
function getCachePath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.cache`)
}

/**
 * Derive encryption key from password using argon2id
 */
function _deriveKey(password, salt) {
  const key = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)

  sodium.crypto_pwhash(
    key,
    b4a.from(password),
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_DEFAULT
  )

  return key
}

/**
 * Encrypt data with password using sodium secretbox
 */
function encrypt(plaintext, password) {
  // Generate random salt and nonce
  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)

  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  // Derive key from password
  const key = _deriveKey(password, salt)

  // Prepare plaintext buffer
  const plaintextBuf = b4a.from(plaintext)

  // Encrypt with secretbox
  const ciphertext = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, plaintextBuf, nonce, key)

  return {
    salt: b4a.toString(salt, 'hex'),
    nonce: b4a.toString(nonce, 'hex'),
    ciphertext: b4a.toString(ciphertext, 'hex')
  }
}

/**
 * Decrypt data with password using sodium secretbox
 */
function decrypt(encryptedData, password) {
  const salt = b4a.from(encryptedData.salt, 'hex')
  const nonce = b4a.from(encryptedData.nonce, 'hex')
  const ciphertext = b4a.from(encryptedData.ciphertext, 'hex')

  // Derive key from password
  const key = _deriveKey(password, salt)

  // Decrypt
  const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)

  if (!success) {
    throw new Error('Invalid password')
  }

  return plaintext.toString()
}

/**
 * Check if a wallet exists for an account
 */
export function walletExists(dataDir, accountName) {
  const walletPath = getWalletPath(dataDir, accountName)
  return fs.existsSync(walletPath)
}

/**
 * Save wallet data encrypted with password
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {Object} walletData - {seed, primaryAddress, restoreHeight}
 * @param {string} password - Encryption password
 */
export async function saveWallet(dataDir, accountName, walletData, password) {
  validateAccountName(accountName)

  // Ensure wallets directory exists
  const walletsDir = getWalletsDir(dataDir)
  fs.mkdirSync(walletsDir, { recursive: true })

  // Encrypt the sensitive data (seed)
  const sensitiveData = JSON.stringify({
    seed: walletData.seed
  })
  const encrypted = encrypt(sensitiveData, password)

  // Build wallet file with unencrypted metadata for display when locked
  const walletFile = {
    version: 1,
    encrypted: true,
    salt: encrypted.salt,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    primaryAddress: walletData.primaryAddress,
    restoreHeight: walletData.restoreHeight,
    lastSyncedHeight: walletData.lastSyncedHeight || null
  }

  const walletPath = getWalletPath(dataDir, accountName)
  fs.writeFileSync(walletPath, JSON.stringify(walletFile, null, 2), 'utf8')
}

/**
 * Load and decrypt wallet data
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {string} password - Decryption password
 * @returns {Object} {seed, primaryAddress, restoreHeight}
 * @throws {Error} On wrong password or wallet not found
 */
export async function loadWallet(dataDir, accountName, password) {
  validateAccountName(accountName)

  const walletPath = getWalletPath(dataDir, accountName)

  if (!fs.existsSync(walletPath)) {
    throw new Error('Wallet not found')
  }

  let walletFile
  try {
    walletFile = JSON.parse(fs.readFileSync(walletPath, 'utf8'))
  } catch (err) {
    throw new Error('Wallet file corrupted: ' + err.message)
  }

  if (!walletFile.encrypted) {
    throw new Error('Invalid wallet format')
  }

  // Decrypt sensitive data
  const decryptedJson = decrypt({
    salt: walletFile.salt,
    nonce: walletFile.nonce,
    ciphertext: walletFile.ciphertext
  }, password)

  const sensitiveData = JSON.parse(decryptedJson)

  return {
    seed: sensitiveData.seed,
    primaryAddress: walletFile.primaryAddress,
    restoreHeight: walletFile.restoreHeight
  }
}

/**
 * Get wallet metadata (unencrypted fields) without password
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @returns {Object|null} {primaryAddress, restoreHeight} or null if not found
 */
export function getWalletMeta(dataDir, accountName) {
  try {
    validateAccountName(accountName)

    const walletPath = getWalletPath(dataDir, accountName)

    if (!fs.existsSync(walletPath)) {
      return null
    }

    const walletFile = JSON.parse(fs.readFileSync(walletPath, 'utf8'))

    return {
      primaryAddress: walletFile.primaryAddress,
      restoreHeight: walletFile.restoreHeight,
      lastSyncedHeight: walletFile.lastSyncedHeight || null
    }
  } catch (err) {
    return null
  }
}

/**
 * Update lastSyncedHeight without re-encrypting seed
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {number} height - Last synced block height
 */
export function updateLastSyncedHeight(dataDir, accountName, height) {
  validateAccountName(accountName)

  const walletPath = getWalletPath(dataDir, accountName)

  if (!fs.existsSync(walletPath)) {
    throw new Error('Wallet not found')
  }

  let walletFile
  try {
    walletFile = JSON.parse(fs.readFileSync(walletPath, 'utf8'))
  } catch (err) {
    throw new Error('Wallet file corrupted: ' + err.message)
  }
  walletFile.lastSyncedHeight = height

  fs.writeFileSync(walletPath, JSON.stringify(walletFile, null, 2), 'utf8')
}

/**
 * Save wallet sync cache encrypted with view key
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {*} cacheData - Cache data to store
 * @param {string} viewKey - View key for encryption
 * @param {number} height - Last synced block height
 */
export async function saveWalletCache(dataDir, accountName, cacheData, viewKey, height) {
  validateAccountName(accountName)

  // Ensure wallets directory exists
  const walletsDir = getWalletsDir(dataDir)
  fs.mkdirSync(walletsDir, { recursive: true })

  // Encrypt cache data with view key
  const cacheJson = JSON.stringify({
    data: cacheData,
    height: height
  })
  const encrypted = encrypt(cacheJson, viewKey)

  const cacheFile = {
    version: 1,
    salt: encrypted.salt,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext
  }

  const cachePath = getCachePath(dataDir, accountName)
  fs.writeFileSync(cachePath, JSON.stringify(cacheFile, null, 2), 'utf8')
}

/**
 * Load and decrypt wallet sync cache
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {string} viewKey - View key for decryption
 * @returns {Object|null} {data, height} or null if not found/invalid
 */
export async function loadWalletCache(dataDir, accountName, viewKey) {
  try {
    validateAccountName(accountName)

    const cachePath = getCachePath(dataDir, accountName)

    if (!fs.existsSync(cachePath)) {
      return null
    }

    const cacheFile = JSON.parse(fs.readFileSync(cachePath, 'utf8'))

    // Decrypt cache data with view key
    const decryptedJson = decrypt({
      salt: cacheFile.salt,
      nonce: cacheFile.nonce,
      ciphertext: cacheFile.ciphertext
    }, viewKey)

    const cacheData = JSON.parse(decryptedJson)

    return {
      data: cacheData.data,
      height: cacheData.height
    }
  } catch (err) {
    // Cache invalid or corrupted, return null to trigger resync
    return null
  }
}

/**
 * Delete wallet and cache files for an account
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 */
export function deleteWallet(dataDir, accountName) {
  validateAccountName(accountName)

  const walletPath = getWalletPath(dataDir, accountName)
  const cachePath = getCachePath(dataDir, accountName)
  const syncDataPath = getSyncDataPath(dataDir, accountName)
  const binaryPath = getWalletBinaryPath(dataDir, accountName)

  if (fs.existsSync(walletPath)) {
    fs.unlinkSync(walletPath)
  }

  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath)
  }

  if (fs.existsSync(syncDataPath)) {
    fs.unlinkSync(syncDataPath)
  }

  if (fs.existsSync(binaryPath)) {
    fs.unlinkSync(binaryPath)
  }
}

/**
 * Get sync data file path
 */
function getSyncDataPath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.sync.json`)
}

/**
 * Get wallet binary data file path
 */
function getWalletBinaryPath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.wallet.bin`)
}

/**
 * Encrypt binary data (Uint8Array/Buffer) with password using sodium secretbox
 * Returns base64-encoded values for JSON storage
 */
function encryptBinary(data, password) {
  // Generate random salt and nonce
  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)

  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  // Derive key from password
  const key = _deriveKey(password, salt)

  // Ensure data is a buffer
  const plaintextBuf = b4a.from(data)

  // Encrypt with secretbox
  const ciphertext = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, plaintextBuf, nonce, key)

  return {
    salt: b4a.toString(salt, 'base64'),
    nonce: b4a.toString(nonce, 'base64'),
    ciphertext: b4a.toString(ciphertext, 'base64')
  }
}

/**
 * Decrypt binary data with password using sodium secretbox
 * Returns Uint8Array
 */
function decryptBinary(encryptedData, password) {
  const salt = b4a.from(encryptedData.salt, 'base64')
  const nonce = b4a.from(encryptedData.nonce, 'base64')
  const ciphertext = b4a.from(encryptedData.ciphertext, 'base64')

  // Derive key from password
  const key = _deriveKey(password, salt)

  // Decrypt
  const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)

  if (!success) {
    throw new Error('Invalid password')
  }

  return new Uint8Array(plaintext)
}

/**
 * Convert a value to a JSON-serializable format
 * Handles BigInt conversion to string
 */
function toSerializable(value) {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}

/**
 * Save wallet sync data (balance + transaction history)
 * This data is NOT encrypted - it contains no secrets, only public blockchain data
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {Object} data - { balance: {confirmed, unconfirmed}, txHistory: [...] }
 */
export function saveWalletSyncData(dataDir, accountName, data) {
  validateAccountName(accountName)

  // Ensure wallets directory exists
  const walletsDir = getWalletsDir(dataDir)
  fs.mkdirSync(walletsDir, { recursive: true })

  // Convert BigInt values to strings for JSON serialization
  // Note: monero-ts may return BigInt for height, timestamp, confirmations, etc.
  const serializableData = {
    version: 1,
    savedAt: Date.now(),
    balance: {
      confirmed: data.balance.confirmed.toString(),
      unconfirmed: data.balance.unconfirmed.toString()
    },
    txHistory: data.txHistory.map(tx => ({
      txid: tx.txid,
      height: toSerializable(tx.height),
      timestamp: toSerializable(tx.timestamp),
      isIncoming: tx.isIncoming,
      isOutgoing: tx.isOutgoing,
      amount: tx.amount.toString(),
      fee: tx.fee.toString(),
      confirmations: toSerializable(tx.confirmations),
      subaddressIndices: tx.subaddressIndices || []  // For linking tips to posts
    }))
  }

  const syncDataPath = getSyncDataPath(dataDir, accountName)
  fs.writeFileSync(syncDataPath, JSON.stringify(serializableData, null, 2), 'utf8')
}

/**
 * Parse a stored value back to a number
 * Handles both string and number formats for backwards compatibility
 */
function parseStoredNumber(value) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === 'string') {
    return parseInt(value, 10)
  }
  return value
}

/**
 * Load wallet sync data (balance + transaction history)
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @returns {Object|null} { balance: {confirmed, unconfirmed}, txHistory: [...] } or null if not found
 */
export function getWalletSyncData(dataDir, accountName) {
  try {
    validateAccountName(accountName)

    const syncDataPath = getSyncDataPath(dataDir, accountName)

    if (!fs.existsSync(syncDataPath)) {
      return null
    }

    const data = JSON.parse(fs.readFileSync(syncDataPath, 'utf8'))

    // Convert string values back to appropriate types
    return {
      savedAt: data.savedAt,
      balance: {
        confirmed: BigInt(data.balance.confirmed),
        unconfirmed: BigInt(data.balance.unconfirmed)
      },
      txHistory: data.txHistory.map(tx => ({
        txid: tx.txid,
        height: parseStoredNumber(tx.height),
        timestamp: parseStoredNumber(tx.timestamp),
        isIncoming: tx.isIncoming,
        isOutgoing: tx.isOutgoing,
        amount: BigInt(tx.amount),
        fee: BigInt(tx.fee),
        confirmations: parseStoredNumber(tx.confirmations) || 0,
        subaddressIndices: tx.subaddressIndices || []  // For linking tips to posts
      }))
    }
  } catch (err) {
    console.warn('[WalletStorage] Failed to load sync data:', err.message)
    return null
  }
}

/**
 * Save wallet binary data (keysData + cacheData) encrypted with password
 * Used for proper delta sync with monero-ts
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {Uint8Array|Buffer} keysData - Wallet keys binary data
 * @param {Uint8Array|Buffer} cacheData - Wallet cache binary data
 * @param {string} password - Encryption password
 */
export async function saveWalletBinaryData(dataDir, accountName, keysData, cacheData, password) {
  validateAccountName(accountName)

  // Ensure wallets directory exists
  const walletsDir = getWalletsDir(dataDir)
  fs.mkdirSync(walletsDir, { recursive: true })

  // Encrypt both blobs separately (each with its own salt/nonce)
  const encryptedKeys = encryptBinary(keysData, password)
  const encryptedCache = encryptBinary(cacheData, password)

  // Build the binary wallet file
  const binaryFile = {
    version: 1,
    savedAt: Date.now(),
    keys: {
      salt: encryptedKeys.salt,
      nonce: encryptedKeys.nonce,
      ciphertext: encryptedKeys.ciphertext
    },
    cache: {
      salt: encryptedCache.salt,
      nonce: encryptedCache.nonce,
      ciphertext: encryptedCache.ciphertext
    }
  }

  const binaryPath = getWalletBinaryPath(dataDir, accountName)
  fs.writeFileSync(binaryPath, JSON.stringify(binaryFile, null, 2), 'utf8')
}

/**
 * Load and decrypt wallet binary data
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {string} password - Decryption password
 * @returns {Object|null} { keysData: Uint8Array, cacheData: Uint8Array } or null if not found
 * @throws {Error} On wrong password (decryption fails)
 */
export async function loadWalletBinaryData(dataDir, accountName, password) {
  validateAccountName(accountName)

  const binaryPath = getWalletBinaryPath(dataDir, accountName)

  if (!fs.existsSync(binaryPath)) {
    return null
  }

  const binaryFile = JSON.parse(fs.readFileSync(binaryPath, 'utf8'))

  // Decrypt both blobs (throws on wrong password)
  const keysData = decryptBinary(binaryFile.keys, password)
  const cacheData = decryptBinary(binaryFile.cache, password)

  return {
    keysData,
    cacheData
  }
}

/**
 * Check if wallet binary data exists for an account
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @returns {boolean} True if binary wallet data exists
 */
export function hasWalletBinaryData(dataDir, accountName) {
  try {
    validateAccountName(accountName)
    const binaryPath = getWalletBinaryPath(dataDir, accountName)
    return fs.existsSync(binaryPath)
  } catch (err) {
    return false
  }
}

/**
 * Delete wallet binary data file
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 */
export function deleteWalletBinaryData(dataDir, accountName) {
  validateAccountName(accountName)

  const binaryPath = getWalletBinaryPath(dataDir, accountName)

  if (fs.existsSync(binaryPath)) {
    fs.unlinkSync(binaryPath)
  }
}

/**
 * Get tip mappings file path
 */
function getTipMappingsPath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.tips.json`)
}

/**
 * Save tip mappings (txHash -> post info for outgoing tips)
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {object} mappings - Object of { txHash: { pubkey, timestamp } }
 */
export function saveTipMappings(dataDir, accountName, mappings) {
  validateAccountName(accountName)

  const walletsDir = getWalletsDir(dataDir)
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true })
  }

  const filePath = getTipMappingsPath(dataDir, accountName)
  fs.writeFileSync(filePath, JSON.stringify(mappings, null, 2))
}

/**
 * Load tip mappings
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @returns {object|null} Mappings object or null if not found
 */
export function loadTipMappings(dataDir, accountName) {
  validateAccountName(accountName)

  const filePath = getTipMappingsPath(dataDir, accountName)

  if (!fs.existsSync(filePath)) {
    return null
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(content)
  } catch (e) {
    console.warn('[WalletStorage] Error loading tip mappings:', e.message)
    return null
  }
}

/**
 * Get announced tips file path
 */
function getAnnouncedTipsPath(dataDir, accountName) {
  validateAccountName(accountName)
  return path.join(getWalletsDir(dataDir), `${accountName}.announced-tips.json`)
}

/**
 * Save list of announced tip transaction IDs
 * These are incoming tips that have already been announced via tip_received events
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @param {Array<string>} txids - Array of transaction IDs
 */
export function saveAnnouncedTips(dataDir, accountName, txids) {
  validateAccountName(accountName)

  const walletsDir = getWalletsDir(dataDir)
  if (!fs.existsSync(walletsDir)) {
    fs.mkdirSync(walletsDir, { recursive: true })
  }

  const filePath = getAnnouncedTipsPath(dataDir, accountName)
  fs.writeFileSync(filePath, JSON.stringify({ txids }, null, 2))
}

/**
 * Load list of announced tip transaction IDs
 * @param {string} dataDir - Data directory
 * @param {string} accountName - Account name
 * @returns {Array<string>|null} Array of txids or null if not found
 */
export function loadAnnouncedTips(dataDir, accountName) {
  validateAccountName(accountName)

  const filePath = getAnnouncedTipsPath(dataDir, accountName)

  if (!fs.existsSync(filePath)) {
    return null
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(content)
    return data.txids || []
  } catch (e) {
    console.warn('[WalletStorage] Error loading announced tips:', e.message)
    return null
  }
}
