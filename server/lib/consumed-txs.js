/**
 * Consumed Transactions - Persistent set of tx hashes that have been used
 * for sync activation. Prevents a single on-chain payment from activating
 * multiple accounts.
 *
 * Storage: server/data/consumed-txs.json  (atomic write, 0600)
 */

import fs from 'fs'
import path from 'path'

export class ConsumedTxs {
  constructor(dataDir) {
    this._filePath = path.join(dataDir, 'consumed-txs.json')
    this._dataDir = dataDir
    this._set = new Set()
  }

  load() {
    try {
      if (!fs.existsSync(this._filePath)) {
        console.log('[ConsumedTxs] No file, starting empty')
        return
      }
      const raw = fs.readFileSync(this._filePath, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        console.error('[ConsumedTxs] Corrupt file, starting empty:', err.message)
        return
      }
      const arr = Array.isArray(parsed?.txHashes) ? parsed.txHashes : []
      this._set = new Set(arr)
      console.log(`[ConsumedTxs] Loaded ${this._set.size} consumed tx hashes`)
    } catch (err) {
      console.error('[ConsumedTxs] Load error:', err.message)
    }
  }

  has(txHash) {
    return this._set.has(txHash)
  }

  /**
   * Record a tx hash as consumed. Persists atomically.
   * @returns {boolean} true if newly added, false if already present
   */
  add(txHash) {
    if (!txHash || typeof txHash !== 'string') return false
    if (this._set.has(txHash)) return false
    this._set.add(txHash)
    this._persist()
    return true
  }

  _persist() {
    try {
      fs.mkdirSync(this._dataDir, { recursive: true })
      const tmp = this._filePath + '.tmp'
      const body = JSON.stringify({ txHashes: Array.from(this._set) }, null, 2)
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, this._filePath)
      try { fs.chmodSync(this._filePath, 0o600) } catch (e) { /* ignore */ }
    } catch (err) {
      console.error('[ConsumedTxs] Persist error:', err.message)
    }
  }

  get size() {
    return this._set.size
  }
}
