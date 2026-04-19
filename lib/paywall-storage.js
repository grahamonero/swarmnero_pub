/**
 * Paywall Storage - Persistence for paywall content keys and processed unlocks
 *
 * Two files in the data directory:
 *   - paywall-keys.json    : author-side, maps post_timestamp -> hex contentKey
 *                            (the symmetric key used to encrypt the post body)
 *   - processed-unlocks.json: author-side, set of "post_timestamp:tx_hash" entries
 *                            already processed (idempotency)
 */

import fs from 'fs'
import path from 'path'
import { encryptMessage, decryptMessage } from './dm-crypto.js'

let dataDir = null
let encryptionKey = null // 32-byte key derived from identity, set after login

/**
 * Set the encryption key for paywall-keys.json at rest.
 * Call this after identity is loaded with deriveLocalStorageKey(identity.secretKey).
 */
export function setEncryptionKey(key) {
  encryptionKey = key
}

/**
 * Set the data directory used for storing paywall files
 */
export function setDataDir(dir) {
  dataDir = dir
}

function getKeysPath() {
  if (!dataDir) throw new Error('paywall-storage data directory not set')
  return path.join(dataDir, 'paywall-keys.json')
}

function getProcessedPath() {
  if (!dataDir) throw new Error('paywall-storage data directory not set')
  return path.join(dataDir, 'processed-unlocks.json')
}

/**
 * Load all author-side content keys from disk
 * @returns {Object} { [post_timestamp]: hexContentKey }
 */
export function loadContentKeys() {
  try {
    const p = getKeysPath()
    if (!fs.existsSync(p)) return {}
    const data = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(data) || {}

    // Encrypted format: { nonce, ciphertext }
    if (parsed.nonce && parsed.ciphertext && encryptionKey) {
      const json = decryptMessage(parsed, encryptionKey)
      if (!json) {
        console.warn('[PaywallStorage] Failed to decrypt content keys')
        return {}
      }
      return JSON.parse(json) || {}
    }

    // Legacy plaintext format — migrate on next save
    if (parsed.nonce && parsed.ciphertext && !encryptionKey) {
      console.warn('[PaywallStorage] Encrypted file but no key set yet')
      return {}
    }

    // Legacy plaintext — auto-migrate by re-saving encrypted
    if (encryptionKey && !parsed.nonce) {
      saveContentKeys(parsed)
    }
    return parsed
  } catch (err) {
    console.warn('[PaywallStorage] Error loading content keys:', err.message)
    return {}
  }
}

/**
 * Persist all author-side content keys to disk
 */
export function saveContentKeys(keysMap) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const p = getKeysPath()
    const tmp = p + '.tmp'
    let content
    if (encryptionKey) {
      const json = JSON.stringify(keysMap)
      const encrypted = encryptMessage(json, encryptionKey)
      content = JSON.stringify(encrypted, null, 2)
    } else {
      content = JSON.stringify(keysMap, null, 2)
    }
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, 0o600) } catch (e) { /* ignore */ }
  } catch (err) {
    console.error('[PaywallStorage] Error saving content keys:', err.message)
  }
}

/**
 * Add or update a single content key
 */
export function setContentKey(postTimestamp, hexKey) {
  const keys = loadContentKeys()
  keys[String(postTimestamp)] = hexKey
  saveContentKeys(keys)
}

/**
 * Get a content key for a specific post (or null)
 */
export function getContentKey(postTimestamp) {
  const keys = loadContentKeys()
  return keys[String(postTimestamp)] || null
}

/**
 * Load the set of already-processed unlock requests
 * @returns {Set<string>} Set of "post_timestamp:tx_hash" strings
 */
export function loadProcessedUnlocks() {
  try {
    const p = getProcessedPath()
    if (!fs.existsSync(p)) return new Set()
    const data = fs.readFileSync(p, 'utf8')
    const arr = JSON.parse(data) || []
    return new Set(arr)
  } catch (err) {
    console.warn('[PaywallStorage] Error loading processed unlocks:', err.message)
    return new Set()
  }
}

/**
 * Persist the processed unlocks set to disk
 */
export function saveProcessedUnlocks(set) {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const p = getProcessedPath()
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(Array.from(set), null, 2), 'utf8')
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, 0o600) } catch (e) { /* ignore */ }
  } catch (err) {
    console.error('[PaywallStorage] Error saving processed unlocks:', err.message)
  }
}

/**
 * Mark an unlock request as processed
 */
export function markUnlockProcessed(postTimestamp, txHash) {
  const set = loadProcessedUnlocks()
  set.add(`${postTimestamp}:${txHash}`)
  saveProcessedUnlocks(set)
}

/**
 * Check if an unlock request has already been processed
 */
export function isUnlockProcessed(postTimestamp, txHash) {
  const set = loadProcessedUnlocks()
  return set.has(`${postTimestamp}:${txHash}`)
}
