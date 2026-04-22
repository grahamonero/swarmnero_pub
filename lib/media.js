import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'

// Default cap for untrusted peer fetches (FoF content, unknown authors).
// Bypassed when the caller passes { noSizeCap: true } — used by the UI when
// the media belongs to an author we directly follow.
export const MAX_PEER_FILE_BYTES = 25 * 1024 * 1024 // 25 MB cap
const MAX_PEER_DRIVES = 100                  // LRU cap on cached peer drives
const SAFE_PATH_PREFIXES = ['/images/', '/videos/', '/files/']
// MIME types we will surface to the UI. SVG is deliberately absent (XSS vector).
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/', 'text/']
const DISALLOWED_MIME = new Set(['image/svg+xml'])

// Thumbnail parameters for the "click to load" preview frame. Generated at
// upload time and embedded inline in the post event as a data URL so the
// follower sees what they're about to download before opting in.
const THUMB_MAX_DIM = 320
const THUMB_QUALITY = 0.55
// Reject thumbs that end up larger than ~60 KB — they bloat the post event.
const THUMB_MAX_CHARS = 84 * 1024 // ~60 KB base64

/**
 * Generate a small JPEG thumbnail data URL from an image File. Returns null
 * on failure or if the encoded result exceeds THUMB_MAX_CHARS.
 */
function imageFileToThumbDataUrl(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(img.width || 1, img.height || 1))
        canvas.width = Math.max(1, Math.round((img.width || 0) * scale))
        canvas.height = Math.max(1, Math.round((img.height || 0) * scale))
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', THUMB_QUALITY)
        resolve(dataUrl && dataUrl.length <= THUMB_MAX_CHARS ? dataUrl : null)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(null)
    }
    img.src = objectUrl
  })
}

/**
 * Generate a thumbnail data URL from a video File by grabbing a frame near
 * the start. Returns null on failure or if result exceeds THUMB_MAX_CHARS.
 */
function videoFileToThumbDataUrl(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    let resolved = false
    const finish = (value) => {
      if (resolved) return
      resolved = true
      URL.revokeObjectURL(objectUrl)
      resolve(value)
    }
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(1, (video.duration || 0) / 4)
      } catch {
        finish(null)
      }
    }
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas')
        const scale = Math.min(1, THUMB_MAX_DIM / Math.max(video.videoWidth || 1, video.videoHeight || 1))
        canvas.width = Math.max(1, Math.round((video.videoWidth || 0) * scale))
        canvas.height = Math.max(1, Math.round((video.videoHeight || 0) * scale))
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', THUMB_QUALITY)
        finish(dataUrl && dataUrl.length <= THUMB_MAX_CHARS ? dataUrl : null)
      } catch {
        finish(null)
      }
    }
    video.onerror = () => finish(null)
    // Timeout fallback — don't hang upload on misbehaving videos
    setTimeout(() => finish(null), 5000)
    video.src = objectUrl
  })
}

/**
 * Media management - Hyperdrive for P2P file storage
 */
export class Media {
  constructor(store, swarm) {
    this.store = store
    this.swarm = swarm
    this.drive = null
    this.peerDrives = new Map() // driveKey -> Hyperdrive (insertion-ordered LRU)
  }

  async init() {
    // Create our own drive for media with a unique namespace
    this.drive = new Hyperdrive(this.store.namespace('media'))
    await this.drive.ready()

    // Join swarm with drive's discovery key
    this.swarm.join(this.drive.discoveryKey)
    await this.swarm.flush()

    return this
  }

  /**
   * Get our drive's public key (for sharing)
   */
  get driveKey() {
    return b4a.toString(this.drive.key, 'hex')
  }

  /**
   * Store an image and return its path. Also generates an inline base64
   * thumbnail so followers can preview oversized attachments before deciding
   * to download the full file.
   */
  async storeImage(file, filename) {
    const timestamp = Date.now()
    const ext = filename.split('.').pop() || 'png'
    const path = `/images/${timestamp}.${ext}`

    const buffer = await file.arrayBuffer()
    await this.drive.put(path, Buffer.from(buffer))

    const thumb = await imageFileToThumbDataUrl(file).catch(() => null)

    return {
      path,
      driveKey: this.driveKey,
      mimeType: this.getMimeType(ext),
      size: buffer.byteLength,
      ...(thumb ? { thumb } : {})
    }
  }

  /**
   * Store a video and return its path. Includes an inline base64 thumbnail
   * extracted from an early frame so followers can preview before opting
   * into a large download.
   */
  async storeVideo(file, filename) {
    const timestamp = Date.now()
    const ext = filename.split('.').pop() || 'mp4'
    const path = `/videos/${timestamp}.${ext}`

    const buffer = await file.arrayBuffer()
    await this.drive.put(path, Buffer.from(buffer))

    const thumb = await videoFileToThumbDataUrl(file).catch(() => null)

    return {
      path,
      driveKey: this.driveKey,
      mimeType: this.getMimeType(ext),
      size: buffer.byteLength,
      type: 'video',
      ...(thumb ? { thumb } : {})
    }
  }

  /**
   * Store a generic file and return its path
   */
  async storeFile(file, filename) {
    const timestamp = Date.now()
    const ext = filename.split('.').pop() || 'bin'
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = `/files/${timestamp}_${safeName}`

    // Read file as buffer
    const buffer = await file.arrayBuffer()
    await this.drive.put(path, Buffer.from(buffer))

    return {
      path,
      driveKey: this.driveKey,
      mimeType: this.getMimeType(ext),
      size: buffer.byteLength,
      filename: filename,
      type: 'file'
    }
  }

  /**
   * Get an image from our drive
   */
  async getImage(path) {
    const data = await this.drive.get(path)
    return data
  }

  /**
   * Get an image from a peer's drive. Set `noSizeCap: true` to skip the
   * MAX_PEER_FILE_BYTES check — used when the caller has confirmed the media
   * comes from an author the user has chosen to follow.
   */
  async getPeerImage(driveKeyHex, path, { noSizeCap = false } = {}) {
    if (!/^[0-9a-f]{64}$/i.test(driveKeyHex)) return null

    let peerDrive = this.peerDrives.get(driveKeyHex)

    if (!peerDrive) {
      // LRU eviction: if we're at cap, drop oldest entry
      if (this.peerDrives.size >= MAX_PEER_DRIVES) {
        const oldestKey = this.peerDrives.keys().next().value
        const oldest = this.peerDrives.get(oldestKey)
        this.peerDrives.delete(oldestKey)
        try {
          if (oldest.discoveryKey) this.swarm.leave(oldest.discoveryKey)
          await oldest.close()
        } catch {}
      }

      const driveKey = b4a.from(driveKeyHex, 'hex')
      peerDrive = new Hyperdrive(this.store.namespace('media'), driveKey)
      await peerDrive.ready()

      // Join swarm to find this peer's drive
      this.swarm.join(peerDrive.discoveryKey)
      await this.swarm.flush()

      this.peerDrives.set(driveKeyHex, peerDrive)
    } else {
      // Touch for LRU: re-insert moves to end
      this.peerDrives.delete(driveKeyHex)
      this.peerDrives.set(driveKeyHex, peerDrive)
    }

    await peerDrive.update()

    // Size check before downloading the whole blob (only when capped)
    if (!noSizeCap) {
      try {
        const entry = await peerDrive.entry(path)
        if (entry?.value?.blob?.byteLength > MAX_PEER_FILE_BYTES) {
          console.warn('[Media] Rejecting peer file: exceeds size cap', path, entry.value.blob.byteLength)
          return null
        }
      } catch {}
    }

    const data = await peerDrive.get(path)
    if (!noSizeCap && data && data.byteLength > MAX_PEER_FILE_BYTES) {
      console.warn('[Media] Rejecting peer file after download: exceeds size cap', path, data.byteLength)
      return null
    }
    return data
  }

  /**
   * Query a peer drive for an entry's size without downloading it. Returns
   * { size } or null. Used by the UI to decide whether to render a
   * "Large file — click to load" badge in place of oversize FoF media.
   */
  async getPeerEntryInfo(driveKeyHex, path) {
    if (!/^[0-9a-f]{64}$/i.test(driveKeyHex)) return null
    try {
      let peerDrive = this.peerDrives.get(driveKeyHex)
      if (!peerDrive) {
        const driveKey = b4a.from(driveKeyHex, 'hex')
        peerDrive = new Hyperdrive(this.store.namespace('media'), driveKey)
        await peerDrive.ready()
        this.swarm.join(peerDrive.discoveryKey)
      }
      await peerDrive.update()
      const entry = await peerDrive.entry(path)
      const size = entry?.value?.blob?.byteLength || 0
      return { size }
    } catch {
      return null
    }
  }

  /**
   * Create a blob URL for displaying an image. `noSizeCap: true` skips the
   * 25 MB peer-file ceiling — pass it when the media belongs to an author
   * the user has chosen to follow (trusted source).
   */
  async getImageUrl(driveKeyHex, path, { noSizeCap = false } = {}) {
    // Validate path shape: only allow our known prefixes and safe chars
    if (typeof path !== 'string' || path.length === 0 || path.length > 512) return null
    if (!SAFE_PATH_PREFIXES.some(p => path.startsWith(p))) return null
    if (path.includes('\0') || path.includes('..')) return null

    let data
    if (driveKeyHex === this.driveKey) {
      data = await this.getImage(path)
    } else {
      data = await this.getPeerImage(driveKeyHex, path, { noSizeCap })
    }

    if (!data) return null

    const ext = path.split('.').pop()
    const mimeType = this.getMimeType(ext)
    // Reject SVG and any MIME we haven't whitelisted
    if (DISALLOWED_MIME.has(mimeType)) return null
    if (!ALLOWED_MIME_PREFIXES.some(p => mimeType.startsWith(p))) return null

    const blob = new Blob([data], { type: mimeType })
    return URL.createObjectURL(blob)
  }

  getMimeType(ext) {
    const types = {
      // Images
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      // Videos
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      'mkv': 'video/x-matroska',
      // Documents
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'md': 'text/markdown',
      'json': 'application/json',
      // Archives
      'zip': 'application/zip',
      'gz': 'application/gzip',
      'tar': 'application/x-tar'
    }
    return types[ext.toLowerCase()] || 'application/octet-stream'
  }

  /**
   * Check if a file is a video based on mime type
   */
  isVideo(mimeType) {
    return mimeType?.startsWith('video/')
  }

  /**
   * Check if a file is an image based on mime type
   */
  isImage(mimeType) {
    return mimeType?.startsWith('image/')
  }

  async close() {
    // Close peer drives
    for (const drive of this.peerDrives.values()) {
      await drive.close()
    }
    if (this.drive) await this.drive.close()
  }
}
