/**
 * Account-scoped encrypted queue storage.
 *
 * Shared infrastructure for Drafts and Scheduled posts: both keep a JSON
 * document at `accounts/<accountId>/<file>.json`, encrypted at rest with
 * deriveLocalStorageKey(identity.secretKey), written atomically
 * (tmp + rename + chmod 0o600) to match paywall-storage.saveContentKeys.
 */

import fs from 'fs'
import path from 'path'
import { encryptMessage, decryptMessage } from './dm-crypto.js'

const ACCOUNT_NAME_RE = /^[a-zA-Z0-9_-]+$/

export function assertValidAccountId(accountId) {
  if (typeof accountId !== 'string' || !ACCOUNT_NAME_RE.test(accountId)) {
    throw new Error('Invalid account id')
  }
}

export function getAccountDir(dataDir, accountId) {
  assertValidAccountId(accountId)
  return path.join(dataDir, 'accounts', accountId)
}

export function ensureAccountDir(dataDir, accountId) {
  const dir = getAccountDir(dataDir, accountId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Resolve a relative path under the account dir, rejecting traversal.
 * Returns the absolute path. Used when restoring attachment paths from disk.
 */
export function resolveWithinAccountDir(dataDir, accountId, relPath) {
  if (typeof relPath !== 'string' || !relPath.length) {
    throw new Error('Invalid path')
  }
  if (relPath.includes('\0')) throw new Error('Invalid path')
  const baseDir = getAccountDir(dataDir, accountId)
  const resolved = path.resolve(baseDir, relPath)
  const normalizedBase = path.resolve(baseDir) + path.sep
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(normalizedBase)) {
    throw new Error('Path escapes account directory')
  }
  return resolved
}

/**
 * Atomic encrypted write: tmp + rename + chmod 0o600.
 * Mirrors paywall-storage.saveContentKeys idiom exactly.
 */
export function writeEncryptedJson(filePath, key, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const json = JSON.stringify(value)
  const encrypted = encryptMessage(json, key)
  const content = JSON.stringify(encrypted)
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch (e) { /* ignore */ }
}

/**
 * Read and decrypt JSON produced by writeEncryptedJson. Returns fallback
 * on missing file or decryption failure.
 */
export function readEncryptedJson(filePath, key, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.nonce || !parsed.ciphertext) return fallback
    const json = decryptMessage(parsed, key)
    if (json == null) return fallback
    return JSON.parse(json)
  } catch (err) {
    console.warn('[account-queue-storage] read failed:', err.message)
    return fallback
  }
}
