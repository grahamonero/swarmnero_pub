/**
 * Draft posts manager.
 *
 * Persists composer state encrypted at `accounts/<accountId>/drafts.json`,
 * with attachment bytes copied into `accounts/<accountId>/drafts/<draftId>/`.
 * Writes are debounced (≤1/500ms) because the composer fires on every keystroke.
 *
 * All attachment paths stored on disk are RELATIVE to the account dir. When
 * restoring, we resolve them back to absolute paths with a traversal check —
 * we never re-dereference absolute paths supplied by an attacker-controlled
 * drafts file.
 */

import fs from 'fs'
import path from 'path'
import sodium from 'sodium-native'
import b4a from 'b4a'
import {
  assertValidAccountId,
  ensureAccountDir,
  getAccountDir,
  resolveWithinAccountDir,
  writeEncryptedJson,
  readEncryptedJson
} from './account-queue-storage.js'

const DEBOUNCE_MS = 500
const DRAFT_ID_RE = /^[a-f0-9]{32}$/

function newDraftId() {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

function draftsFilePath(dataDir, accountId) {
  return path.join(getAccountDir(dataDir, accountId), 'drafts.json')
}

function attachmentDir(dataDir, accountId, draftId) {
  if (!DRAFT_ID_RE.test(draftId)) throw new Error('Invalid draft id')
  return path.join(getAccountDir(dataDir, accountId), 'drafts', draftId)
}

export class DraftStore {
  constructor({ dataDir, accountId, encryptionKey }) {
    assertValidAccountId(accountId)
    if (!encryptionKey || encryptionKey.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error('DraftStore requires a 32-byte encryption key')
    }
    this.dataDir = dataDir
    this.accountId = accountId
    this.key = encryptionKey
    this.drafts = new Map()
    this._pendingWrite = null
    this._destroyed = false
  }

  load() {
    ensureAccountDir(this.dataDir, this.accountId)
    const doc = readEncryptedJson(draftsFilePath(this.dataDir, this.accountId), this.key, null)
    this.drafts = new Map()
    if (doc && Array.isArray(doc.drafts)) {
      for (const d of doc.drafts) {
        if (!d || !DRAFT_ID_RE.test(d.id || '')) continue
        this.drafts.set(d.id, this._sanitizeOnLoad(d))
      }
    }
    return this
  }

  list() {
    return Array.from(this.drafts.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  get(id) {
    return this.drafts.get(id) || null
  }

  /**
   * Upsert the given draft. Attachments are an array of either:
   *   - { kind:'stored', relPath, name, mime, size }  (already in account dir)
   *   - { kind:'buffer', bytes:Buffer, name, mime }   (fresh; will be copied)
   */
  upsert({ id, content, media, files, paywall, mode, article }) {
    const now = Date.now()
    const draftId = (id && DRAFT_ID_RE.test(id)) ? id : newDraftId()
    const existing = this.drafts.get(draftId) || { id: draftId, createdAt: now, media: [], files: [] }
    const next = {
      id: draftId,
      createdAt: existing.createdAt || now,
      updatedAt: now,
      content: typeof content === 'string' ? content : '',
      media: this._persistAttachments(draftId, 'media', media || existing.media || []),
      files: this._persistAttachments(draftId, 'files', files || existing.files || []),
      paywall: paywall && typeof paywall === 'object' ? {
        enabled: !!paywall.enabled,
        price: typeof paywall.price === 'string' ? paywall.price : '',
        preview: typeof paywall.preview === 'string' ? paywall.preview : ''
      } : null,
      // Phase 2A: article-mode drafts carry title + summary alongside the body
      // (which is stored in `content`). Mode discriminator allows future
      // poll-mode drafts to land here too.
      mode: (mode === 'article' || mode === 'post') ? mode : 'post',
      article: article && typeof article === 'object' ? {
        title: typeof article.title === 'string' ? article.title.slice(0, 200) : '',
        summary: typeof article.summary === 'string' ? article.summary.slice(0, 500) : ''
      } : null
    }
    this.drafts.set(draftId, next)
    this._scheduleSave()
    return next
  }

  delete(id) {
    if (!this.drafts.has(id)) return
    this.drafts.delete(id)
    // Best-effort cleanup of the attachment dir.
    try {
      const dir = attachmentDir(this.dataDir, this.accountId, id)
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn('[DraftStore] cleanup failed:', err.message)
    }
    this._scheduleSave()
  }

  /**
   * Flush any pending debounced save immediately. Call on account switch /
   * logout so in-flight edits land on disk before state is torn down.
   */
  flush() {
    if (this._pendingWrite) {
      clearTimeout(this._pendingWrite)
      this._pendingWrite = null
      this._saveNow()
    }
  }

  destroy() {
    this._destroyed = true
    if (this._pendingWrite) {
      clearTimeout(this._pendingWrite)
      this._pendingWrite = null
    }
    this.drafts.clear()
    this.key = null
  }

  _scheduleSave() {
    if (this._destroyed) return
    if (this._pendingWrite) return
    this._pendingWrite = setTimeout(() => {
      this._pendingWrite = null
      this._saveNow()
    }, DEBOUNCE_MS)
  }

  _saveNow() {
    if (this._destroyed || !this.key) return
    try {
      const doc = { drafts: Array.from(this.drafts.values()) }
      writeEncryptedJson(draftsFilePath(this.dataDir, this.accountId), this.key, doc)
    } catch (err) {
      console.warn('[DraftStore] save failed:', err.message)
    }
  }

  _persistAttachments(draftId, kind, items) {
    if (!Array.isArray(items)) return []
    const dir = attachmentDir(this.dataDir, this.accountId, draftId)
    const out = []
    for (const item of items) {
      if (!item) continue
      if (item.kind === 'stored' && typeof item.relPath === 'string') {
        // Validate that the relPath stays within the account dir. Do not
        // trust absolute paths from an attacker-controlled drafts file.
        try {
          resolveWithinAccountDir(this.dataDir, this.accountId, item.relPath)
        } catch {
          continue
        }
        out.push({
          kind: 'stored',
          relPath: item.relPath,
          name: typeof item.name === 'string' ? item.name : '',
          mime: typeof item.mime === 'string' ? item.mime : '',
          size: Number.isFinite(item.size) ? item.size : 0
        })
        continue
      }
      if (item.kind === 'buffer' && item.bytes) {
        try {
          fs.mkdirSync(dir, { recursive: true })
          const fileId = newDraftId()
          const absPath = path.join(dir, `${kind}-${fileId}.bin`)
          const tmp = absPath + '.tmp'
          fs.writeFileSync(tmp, item.bytes)
          fs.renameSync(tmp, absPath)
          try { fs.chmodSync(absPath, 0o600) } catch (e) { /* ignore */ }
          const relPath = path.relative(getAccountDir(this.dataDir, this.accountId), absPath)
          out.push({
            kind: 'stored',
            relPath,
            name: typeof item.name === 'string' ? item.name : '',
            mime: typeof item.mime === 'string' ? item.mime : '',
            size: item.bytes.length
          })
        } catch (err) {
          console.warn('[DraftStore] attachment write failed:', err.message)
        }
      }
    }
    return out
  }

  _sanitizeOnLoad(d) {
    return {
      id: d.id,
      createdAt: Number(d.createdAt) || Date.now(),
      updatedAt: Number(d.updatedAt) || Date.now(),
      content: typeof d.content === 'string' ? d.content : '',
      media: Array.isArray(d.media) ? d.media.filter(m => {
        if (!m || m.kind !== 'stored' || typeof m.relPath !== 'string') return false
        try { resolveWithinAccountDir(this.dataDir, this.accountId, m.relPath) } catch { return false }
        return true
      }) : [],
      files: Array.isArray(d.files) ? d.files.filter(m => {
        if (!m || m.kind !== 'stored' || typeof m.relPath !== 'string') return false
        try { resolveWithinAccountDir(this.dataDir, this.accountId, m.relPath) } catch { return false }
        return true
      }) : [],
      paywall: d.paywall && typeof d.paywall === 'object' ? {
        enabled: !!d.paywall.enabled,
        price: typeof d.paywall.price === 'string' ? d.paywall.price : '',
        preview: typeof d.paywall.preview === 'string' ? d.paywall.preview : ''
      } : null,
      mode: (d.mode === 'article' || d.mode === 'post') ? d.mode : 'post',
      article: d.article && typeof d.article === 'object' ? {
        title: typeof d.article.title === 'string' ? d.article.title.slice(0, 200) : '',
        summary: typeof d.article.summary === 'string' ? d.article.summary.slice(0, 500) : ''
      } : null
    }
  }

  /**
   * Read the bytes of a stored attachment back into memory. Validates that
   * the path is within the account dir before touching the filesystem.
   */
  readAttachmentBytes(relPath) {
    const abs = resolveWithinAccountDir(this.dataDir, this.accountId, relPath)
    return fs.readFileSync(abs)
  }
}
