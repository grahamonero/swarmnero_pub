/**
 * Persistent cache of discovered peers' profiles, keyed by pubkey.
 *
 * Populated from Discovery hello payloads (signed by the peer), so stale-but-
 * once-seen profiles can render follower/FoF lists even when the peer is
 * offline.
 *
 * Stored at {dataDir}/peer-profiles-{pubkeyHex}.json — scoped per account so
 * entries from other local accounts don't leak in.
 */
import fs from 'fs'
import path from 'path'

const MAX_ENTRIES = 500 // FIFO cap to keep the file small
const SAVE_DEBOUNCE_MS = 2000

const saveTimers = new Map() // "dataDir:pubkeyHex" -> Timeout

function filePath(dataDir, pubkeyHex) {
  return path.join(dataDir, `peer-profiles-${pubkeyHex}.json`)
}

export function loadPeerProfiles(dataDir, pubkeyHex) {
  if (!dataDir || !pubkeyHex) return {}
  const file = filePath(dataDir, pubkeyHex)
  try {
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed.profiles || {}
  } catch (err) {
    console.warn('[PeerProfileCache] Load failed:', err.message)
    return {}
  }
}

export function savePeerProfilesDebounced(dataDir, pubkeyHex, profiles) {
  if (!dataDir || !pubkeyHex || !profiles) return
  const key = `${dataDir}:${pubkeyHex}`
  const existing = saveTimers.get(key)
  if (existing) clearTimeout(existing)
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key)
    _writeNow(dataDir, pubkeyHex, profiles)
  }, SAVE_DEBOUNCE_MS))
}

function _writeNow(dataDir, pubkeyHex, profiles) {
  const file = filePath(dataDir, pubkeyHex)
  try {
    // Keep only entries with at least a name or avatar, and cap total size.
    const usable = Object.entries(profiles || {})
      .filter(([pk, p]) => /^[a-f0-9]{64}$/i.test(pk) && p && (p.name || p.avatar || p.bio || p.website))
    const trimmed = Object.fromEntries(usable.slice(-MAX_ENTRIES))
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: trimmed }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    console.warn('[PeerProfileCache] Save failed:', err.message)
  }
}
