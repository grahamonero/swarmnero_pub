import sodium from 'sodium-native'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'

/**
 * Identity management - Ed25519 keypair generation and storage
 */

export function generateKeypair() {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

export function sign(message, secretKey) {
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, b4a.from(message), secretKey)
  return signature
}

export function verify(message, signature, publicKey) {
  return sodium.crypto_sign_verify_detached(signature, b4a.from(message), publicKey)
}

export function pubkeyToHex(publicKey) {
  return b4a.toString(publicKey, 'hex')
}

export function hexToPubkey(hex) {
  return b4a.from(hex, 'hex')
}

/**
 * Identity storage - saves keypair to disk
 */
export class Identity {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.publicKey = null
    this.secretKey = null
  }

  get pubkeyHex() {
    return this.publicKey ? pubkeyToHex(this.publicKey) : null
  }

  async load() {
    const keyPath = path.join(this.dataDir, 'identity.json')
    try {
      const data = fs.readFileSync(keyPath, 'utf8')
      let parsed
      try {
        parsed = JSON.parse(data)
      } catch (parseErr) {
        console.error('Identity file corrupted:', parseErr.message)
        return false
      }
      if (!parsed.publicKey || !parsed.secretKey) {
        console.error('Identity file missing required fields')
        return false
      }
      this.publicKey = b4a.from(parsed.publicKey, 'hex')
      this.secretKey = b4a.from(parsed.secretKey, 'hex')
      return true
    } catch (err) {
      if (err.code === 'ENOENT') return false
      throw err
    }
  }

  async create() {
    const { publicKey, secretKey } = generateKeypair()
    this.publicKey = publicKey
    this.secretKey = secretKey
    await this.save()
    return this
  }

  async save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
    } catch (e) {
      // ignore if exists
    }
    const keyPath = path.join(this.dataDir, 'identity.json')
    const data = JSON.stringify({
      publicKey: pubkeyToHex(this.publicKey),
      secretKey: b4a.toString(this.secretKey, 'hex')
    }, null, 2)
    fs.writeFileSync(keyPath, data, 'utf8')
    try { fs.chmodSync(keyPath, 0o600) } catch (e) { /* ignore on platforms without chmod */ }
  }

  async loadOrCreate() {
    const loaded = await this.load()
    if (!loaded) await this.create()
    return this
  }

  sign(message) {
    return sign(message, this.secretKey)
  }

  verify(message, signature) {
    return verify(message, signature, this.publicKey)
  }
}
