/**
 * Account management - multiple identities with optional password encryption
 */

import sodium from 'sodium-native'
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import { Identity, generateKeypair, pubkeyToHex } from './identity.js'

/**
 * Validate account name to prevent path traversal attacks
 */
function validateAccountName(name) {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Invalid account name: must contain only letters, numbers, underscores, and hyphens')
  }
}

export class AccountManager {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.identitiesDir = path.join(dataDir, 'identities')
    this.metaPath = path.join(dataDir, 'accounts.json')
    this.deviceKeyPath = path.join(dataDir, 'device.key')
    this.accounts = []
    this.activeAccount = null
    this.currentIdentity = null
    this._deviceKey = null
  }

  /**
   * Get or create the device key for baseline encryption
   * This provides protection against casual file access when no password is set
   */
  _getDeviceKey() {
    if (this._deviceKey) {
      return this._deviceKey
    }

    if (fs.existsSync(this.deviceKeyPath)) {
      // Load existing device key
      const keyHex = fs.readFileSync(this.deviceKeyPath, 'utf8').trim()
      this._deviceKey = b4a.from(keyHex, 'hex')
    } else {
      // Generate new device key (32 bytes)
      this._deviceKey = b4a.alloc(32)
      sodium.randombytes_buf(this._deviceKey)
      // Save to file
      fs.writeFileSync(this.deviceKeyPath, b4a.toString(this._deviceKey, 'hex'), 'utf8')
      try { fs.chmodSync(this.deviceKeyPath, 0o600) } catch (e) { /* ignore on platforms without chmod */ }
    }

    return this._deviceKey
  }

  /**
   * Load accounts metadata
   */
  async load() {
    try {
      // Ensure directories exist
      fs.mkdirSync(this.identitiesDir, { recursive: true })

      // Check for migration from single identity
      await this._migrateFromSingleIdentity()

      // Load metadata
      if (fs.existsSync(this.metaPath)) {
        let data
        try {
          data = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'))
        } catch (parseErr) {
          console.error('Accounts metadata corrupted, starting fresh:', parseErr.message)
          data = {}
        }
        this.accounts = data.accounts || []
        this.activeAccount = data.activeAccount || null
      }

      // If no accounts, create default
      if (this.accounts.length === 0) {
        await this.createAccount('default')
        this.activeAccount = 'default'
        await this._saveMeta()
      }

      // Don't auto-load - always show welcome screen for account selection
      return this
    } catch (err) {
      console.error('Error loading accounts:', err)
      throw err
    }
  }

  /**
   * Migrate from single identity.json to multi-account
   */
  async _migrateFromSingleIdentity() {
    const oldIdentityPath = path.join(this.dataDir, 'identity.json')

    if (fs.existsSync(oldIdentityPath) && !fs.existsSync(this.metaPath)) {
      console.log('Migrating from single identity to multi-account...')

      try {
        const oldData = JSON.parse(fs.readFileSync(oldIdentityPath, 'utf8'))

        // Create default account from existing identity with device key encryption
        const publicKey = b4a.from(oldData.publicKey, 'hex')
        const secretKey = b4a.from(oldData.secretKey, 'hex')
        const accountFile = this._encryptIdentityWithDeviceKey(publicKey, secretKey)

        fs.writeFileSync(
          path.join(this.identitiesDir, 'default.json'),
          JSON.stringify(accountFile, null, 2),
          'utf8'
        )

        // Create metadata
        this.accounts = [{
          name: 'default',
          pubkeyHex: oldData.publicKey,
          encrypted: false,
          deviceKeyEncrypted: true,
          createdAt: Date.now()
        }]
        this.activeAccount = 'default'
        await this._saveMeta()

        // Backup old file
        fs.renameSync(oldIdentityPath, oldIdentityPath + '.backup')

        console.log('Migration complete')
      } catch (err) {
        console.error('Migration failed:', err)
      }
    }
  }

  /**
   * Save accounts metadata
   */
  async _saveMeta() {
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({
        activeAccount: this.activeAccount,
        accounts: this.accounts
      }, null, 2),
      'utf8'
    )
  }

  /**
   * Create a new account
   */
  async createAccount(name, password = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    // Check if name already exists
    if (this.accounts.find(a => a.name === name)) {
      throw new Error('Account name already exists')
    }

    // Generate new keypair
    const { publicKey, secretKey } = generateKeypair()
    const pubkeyHex = pubkeyToHex(publicKey)

    // Save identity file
    let accountFile
    if (password) {
      accountFile = this._encryptIdentity(publicKey, secretKey, password)
    } else {
      // Use device key for baseline encryption (protects against casual file access)
      accountFile = this._encryptIdentityWithDeviceKey(publicKey, secretKey)
    }

    fs.writeFileSync(
      path.join(this.identitiesDir, `${name}.json`),
      JSON.stringify(accountFile, null, 2),
      'utf8'
    )

    // Add to accounts list
    this.accounts.push({
      name,
      pubkeyHex,
      encrypted: !!password,
      deviceKeyEncrypted: !password,
      createdAt: Date.now()
    })

    await this._saveMeta()

    return { name, pubkeyHex }
  }

  /**
   * Import an account from a secret key
   */
  async importAccount(name, secretKeyHex, password = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    // Check if name already exists
    if (this.accounts.find(a => a.name === name)) {
      throw new Error('Account name already exists')
    }

    // Validate secret key format:
    //   64 hex  = 32-byte seed (legacy)
    //   128 hex = 64-byte identity keypair (legacy)
    //   256 hex = 64-byte identity keypair + 64-byte hypercore keypair (portable)
    if (!/^[0-9a-fA-F]{64}$/.test(secretKeyHex) &&
        !/^[0-9a-fA-F]{128}$/.test(secretKeyHex) &&
        !/^[0-9a-fA-F]{256}$/.test(secretKeyHex)) {
      throw new Error('Invalid secret key format (must be 64, 128, or 256 hex characters)')
    }

    // Split off the optional hypercore keypair half for 256-char exports
    let hypercoreKeyPair = null
    let identityHex = secretKeyHex
    if (secretKeyHex.length === 256) {
      identityHex = secretKeyHex.slice(0, 128)
      const hcoreSecretHex = secretKeyHex.slice(128, 256)
      const hcoreSecret = b4a.from(hcoreSecretHex, 'hex')
      // Last 32 bytes of the 64-byte sodium-ed25519 secret = public key
      const hcorePublic = b4a.from(hcoreSecret.subarray(32, 64))
      hypercoreKeyPair = { publicKey: hcorePublic, secretKey: hcoreSecret }
    }

    // Derive public key from identity secret
    const secretKey = b4a.from(identityHex, 'hex')
    const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)

    if (secretKey.length === 64) {
      publicKey.set(secretKey.subarray(32, 64))
    } else if (secretKey.length === 32) {
      const fullSecret = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      sodium.crypto_sign_seed_keypair(publicKey, fullSecret, secretKey)
    } else {
      throw new Error('Invalid secret key length')
    }

    const pubkeyHex = b4a.toString(publicKey, 'hex')

    // Check if this identity already exists
    const existing = this.accounts.find(a => a.pubkeyHex === pubkeyHex)
    if (existing) {
      throw new Error(`This identity already exists as account "${existing.name}"`)
    }

    // Save identity file, including the hypercore keypair if the export
    // carried it. Without it, the imported account gets a new swarmId on
    // first launch (derived from this device's Corestore); with it, the
    // imported account resumes the original swarmId.
    let accountFile
    if (password) {
      accountFile = this._encryptIdentity(publicKey, secretKey, password, hypercoreKeyPair)
    } else {
      accountFile = this._encryptIdentityWithDeviceKey(publicKey, secretKey, hypercoreKeyPair)
    }

    fs.writeFileSync(
      path.join(this.identitiesDir, `${name}.json`),
      JSON.stringify(accountFile, null, 2),
      'utf8'
    )

    // Add to accounts list. Mark as imported so the init path can skip the
    // "new account" auto-writes (auto-follow of Swarmnero Official + auto-save
    // of a default profile) — those writes would collide with the real data
    // replicating from the account's other device.
    this.accounts.push({
      name,
      pubkeyHex,
      encrypted: !!password,
      deviceKeyEncrypted: !password,
      createdAt: Date.now(),
      imported: true
    })

    await this._saveMeta()

    return { name, pubkeyHex }
  }

  /**
   * Remove the one-shot "imported" flag from an account after its first launch
   * has completed. See app.js init for rationale.
   */
  async clearImportedFlag(name) {
    const account = this.accounts.find(a => a.name === name)
    if (!account || !account.imported) return
    delete account.imported
    await this._saveMeta()
  }

  /**
   * Switch to an account
   */
  async switchAccount(name, password = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }

    const filePath = path.join(this.identitiesDir, `${name}.json`)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    let publicKey, secretKey, hypercoreKeyPair = null

    if (data.encrypted) {
      if (!password) {
        throw new Error('Password required for encrypted account')
      }
      const decrypted = this._decryptIdentity(data, password)
      publicKey = b4a.from(decrypted.publicKey, 'hex')
      secretKey = b4a.from(decrypted.secretKey, 'hex')
      if (decrypted.hypercoreKeyPair) {
        hypercoreKeyPair = {
          publicKey: b4a.from(decrypted.hypercoreKeyPair.publicKey, 'hex'),
          secretKey: b4a.from(decrypted.hypercoreKeyPair.secretKey, 'hex')
        }
      }
    } else if (data.deviceKeyEncrypted) {
      // Decrypt with device key
      const decrypted = this._decryptIdentityWithDeviceKey(data)
      publicKey = b4a.from(decrypted.publicKey, 'hex')
      secretKey = b4a.from(decrypted.secretKey, 'hex')
      if (decrypted.hypercoreKeyPair) {
        hypercoreKeyPair = {
          publicKey: b4a.from(decrypted.hypercoreKeyPair.publicKey, 'hex'),
          secretKey: b4a.from(decrypted.hypercoreKeyPair.secretKey, 'hex')
        }
      }
    } else {
      // Legacy plaintext format - migrate to device key encryption
      publicKey = b4a.from(data.publicKey, 'hex')
      secretKey = b4a.from(data.secretKey, 'hex')
      // Migrate to device key encryption
      const newData = this._encryptIdentityWithDeviceKey(publicKey, secretKey)
      fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8')
      // Update account metadata
      account.deviceKeyEncrypted = true
      await this._saveMeta()
    }

    // Create Identity instance
    const identity = new Identity(this.dataDir)
    identity.publicKey = publicKey
    identity.secretKey = secretKey
    if (hypercoreKeyPair) identity.setHypercoreKeyPair(hypercoreKeyPair)

    this.currentIdentity = identity
    this.activeAccount = name
    // Remember password (if any) so we can re-encrypt when feed extracts
    // the hypercoreKeyPair on first launch after upgrade.
    this._activePassword = password || null
    await this._saveMeta()

    return identity
  }

  /**
   * Re-encrypt the active account's identity file with the hypercoreKeyPair
   * attached. Called by Feed after extracting the keypair from a legacy core
   * on first launch post-upgrade. Idempotent: subsequent launches read the
   * keypair from the file and skip extraction.
   */
  async persistHypercoreKeyPair() {
    if (!this.currentIdentity || !this.currentIdentity.hypercoreKeyPair) {
      throw new Error('No hypercoreKeyPair to persist')
    }
    if (!this.activeAccount) {
      throw new Error('No active account')
    }
    validateAccountName(this.activeAccount)

    const filePath = path.join(this.identitiesDir, `${this.activeAccount}.json`)
    const current = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    let newData
    if (current.encrypted) {
      if (!this._activePassword) {
        throw new Error('Password not available for re-encryption')
      }
      newData = this._encryptIdentity(
        this.currentIdentity.publicKey,
        this.currentIdentity.secretKey,
        this._activePassword,
        this.currentIdentity.hypercoreKeyPair
      )
    } else if (current.deviceKeyEncrypted) {
      newData = this._encryptIdentityWithDeviceKey(
        this.currentIdentity.publicKey,
        this.currentIdentity.secretKey,
        this.currentIdentity.hypercoreKeyPair
      )
    } else {
      throw new Error('Unknown identity file format — cannot persist hypercoreKeyPair')
    }

    // Atomic write: write to temp then rename
    const tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(newData, null, 2), 'utf8')
    try { fs.chmodSync(tmpPath, 0o600) } catch (e) { /* ignore */ }
    fs.renameSync(tmpPath, filePath)
  }

  /**
   * Delete an account
   */
  async deleteAccount(name, password = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }

    // If password-encrypted, verify password first
    if (account.encrypted) {
      if (!password) {
        throw new Error('Password required to delete encrypted account')
      }
      const filePath = path.join(this.identitiesDir, `${name}.json`)
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      // This will throw if password is wrong
      this._decryptIdentity(data, password)
    }
    // Device-key encrypted accounts don't need password verification for deletion

    // Don't allow deleting last account
    if (this.accounts.length === 1) {
      throw new Error('Cannot delete the only account')
    }

    // Remove file
    const filePath = path.join(this.identitiesDir, `${name}.json`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }

    // Remove from accounts list
    this.accounts = this.accounts.filter(a => a.name !== name)

    // If deleting active account, switch to first available
    if (this.activeAccount === name) {
      this.activeAccount = this.accounts[0].name
    }

    await this._saveMeta()
  }

  /**
   * Set password on an account
   */
  async setPassword(name, password, currentPassword = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }

    const filePath = path.join(this.identitiesDir, `${name}.json`)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    let publicKey, secretKey

    // Decrypt if currently encrypted
    if (data.encrypted) {
      if (!currentPassword) {
        throw new Error('Current password required')
      }
      const decrypted = this._decryptIdentity(data, currentPassword)
      publicKey = b4a.from(decrypted.publicKey, 'hex')
      secretKey = b4a.from(decrypted.secretKey, 'hex')
    } else if (data.deviceKeyEncrypted) {
      // Decrypt with device key
      const decrypted = this._decryptIdentityWithDeviceKey(data)
      publicKey = b4a.from(decrypted.publicKey, 'hex')
      secretKey = b4a.from(decrypted.secretKey, 'hex')
    } else {
      // Legacy plaintext format
      publicKey = b4a.from(data.publicKey, 'hex')
      secretKey = b4a.from(data.secretKey, 'hex')
    }

    // Re-encrypt with new password
    const newData = this._encryptIdentity(publicKey, secretKey, password)
    fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8')

    // Update metadata
    account.encrypted = true
    account.deviceKeyEncrypted = false
    await this._saveMeta()
  }

  /**
   * Remove password from an account
   */
  async removePassword(name, currentPassword) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }

    if (!account.encrypted) {
      throw new Error('Account is not encrypted')
    }

    const filePath = path.join(this.identitiesDir, `${name}.json`)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    // Decrypt
    const decrypted = this._decryptIdentity(data, currentPassword)

    // Re-encrypt with device key (baseline protection)
    const publicKey = b4a.from(decrypted.publicKey, 'hex')
    const secretKey = b4a.from(decrypted.secretKey, 'hex')
    const newData = this._encryptIdentityWithDeviceKey(publicKey, secretKey)
    fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf8')

    // Update metadata
    account.encrypted = false
    account.deviceKeyEncrypted = true
    await this._saveMeta()
  }

  /**
   * Get the active account metadata
   */
  getActiveAccount() {
    return this.accounts.find(a => a.name === this.activeAccount)
  }

  /**
   * Update cached profile name for an account
   * Called when user saves their profile to keep welcome screen in sync
   */
  async updateProfileName(accountName, profileName) {
    const account = this.accounts.find(a => a.name === accountName)
    if (account) {
      account.profileName = profileName
      await this._saveMeta()
    }
  }

  /**
   * Export public key (Swarm ID)
   */
  exportSwarmId(name) {
    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }
    return account.pubkeyHex
  }

  /**
   * Export secret key (requires password if encrypted)
   */
  async exportSecretKey(name, password = null) {
    // Validate account name to prevent path traversal
    validateAccountName(name)

    const account = this.accounts.find(a => a.name === name)
    if (!account) {
      throw new Error('Account not found')
    }

    const filePath = path.join(this.identitiesDir, `${name}.json`)
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    let decrypted
    if (data.encrypted) {
      if (!password) {
        throw new Error('Password required for encrypted account')
      }
      decrypted = this._decryptIdentity(data, password)
    } else if (data.deviceKeyEncrypted) {
      decrypted = this._decryptIdentityWithDeviceKey(data)
    } else {
      // Legacy plaintext format
      decrypted = { secretKey: data.secretKey, hypercoreKeyPair: null }
    }

    // If we have the hypercoreKeyPair, concatenate it so the exported string
    // is sufficient to reconstruct the same swarmId on another device.
    // Format: identitySecret(128 hex) + hypercoreSecret(128 hex) = 256 chars.
    // Legacy import paths still accept 64/128-char strings.
    if (decrypted.hypercoreKeyPair && decrypted.hypercoreKeyPair.secretKey) {
      return decrypted.secretKey + decrypted.hypercoreKeyPair.secretKey
    }
    return decrypted.secretKey
  }

  /**
   * Encrypt identity with password using sodium
   */
  _encryptIdentity(publicKey, secretKey, password, hypercoreKeyPair = null) {
    // Generate random salt and nonce
    const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
    sodium.randombytes_buf(salt)

    const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
    sodium.randombytes_buf(nonce)

    // Derive key from password
    const key = this._deriveKey(password, salt)

    // Prepare plaintext
    const payload = {
      publicKey: b4a.toString(publicKey, 'hex'),
      secretKey: b4a.toString(secretKey, 'hex')
    }
    if (hypercoreKeyPair) {
      payload.hypercoreKeyPair = {
        publicKey: b4a.toString(hypercoreKeyPair.publicKey, 'hex'),
        secretKey: b4a.toString(hypercoreKeyPair.secretKey, 'hex')
      }
    }
    const plaintextBuf = b4a.from(JSON.stringify(payload))

    // Encrypt with secretbox
    const ciphertext = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(ciphertext, plaintextBuf, nonce, key)

    return {
      version: hypercoreKeyPair ? 2 : 1,
      encrypted: true,
      salt: b4a.toString(salt, 'hex'),
      nonce: b4a.toString(nonce, 'hex'),
      ciphertext: b4a.toString(ciphertext, 'hex')
    }
  }

  /**
   * Decrypt identity with password using sodium
   */
  _decryptIdentity(encryptedData, password) {
    const salt = b4a.from(encryptedData.salt, 'hex')
    const nonce = b4a.from(encryptedData.nonce, 'hex')
    const ciphertext = b4a.from(encryptedData.ciphertext, 'hex')

    // Derive key from password
    const key = this._deriveKey(password, salt)

    // Decrypt
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
    const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)

    if (!success) {
      throw new Error('Invalid password')
    }

    return JSON.parse(plaintext.toString())
  }

  /**
   * Derive encryption key from password using argon2id
   */
  _deriveKey(password, salt) {
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
   * Encrypt identity with device key (baseline protection for no-password accounts)
   * Uses direct key encryption without argon2id since device key is already high-entropy
   */
  _encryptIdentityWithDeviceKey(publicKey, secretKey, hypercoreKeyPair = null) {
    const deviceKey = this._getDeviceKey()

    // Generate random nonce
    const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
    sodium.randombytes_buf(nonce)

    // Prepare plaintext. hypercoreKeyPair is included if we have it so the
    // feed's Hypercore key is portable across devices — without it, swarmId
    // depends on the local Corestore master and can't be restored elsewhere.
    const payload = {
      publicKey: b4a.toString(publicKey, 'hex'),
      secretKey: b4a.toString(secretKey, 'hex')
    }
    if (hypercoreKeyPair) {
      payload.hypercoreKeyPair = {
        publicKey: b4a.toString(hypercoreKeyPair.publicKey, 'hex'),
        secretKey: b4a.toString(hypercoreKeyPair.secretKey, 'hex')
      }
    }
    const plaintextBuf = b4a.from(JSON.stringify(payload))

    // Encrypt with secretbox using device key directly
    const ciphertext = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
    sodium.crypto_secretbox_easy(ciphertext, plaintextBuf, nonce, deviceKey)

    return {
      version: hypercoreKeyPair ? 2 : 1,
      encrypted: false,
      deviceKeyEncrypted: true,
      nonce: b4a.toString(nonce, 'hex'),
      ciphertext: b4a.toString(ciphertext, 'hex')
    }
  }

  /**
   * Decrypt identity with device key
   */
  _decryptIdentityWithDeviceKey(encryptedData) {
    const deviceKey = this._getDeviceKey()
    const nonce = b4a.from(encryptedData.nonce, 'hex')
    const ciphertext = b4a.from(encryptedData.ciphertext, 'hex')

    // Decrypt
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
    const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, deviceKey)

    if (!success) {
      throw new Error('Failed to decrypt with device key - device.key may be corrupted or missing')
    }

    return JSON.parse(plaintext.toString())
  }
}
