/**
 * DM Crypto - Ed25519 → X25519 conversion and crypto_box encryption
 *
 * Uses sodium-native for all cryptographic operations.
 * Ed25519 keys (signing) are converted to X25519 keys (encryption) for DMs.
 */

import sodium from 'sodium-native'
import b4a from 'b4a'

/**
 * Derive X25519 keypair from Ed25519 secret key
 * @param {Buffer} ed25519SecretKey - 64-byte Ed25519 secret key
 * @returns {{ publicKey: Buffer, secretKey: Buffer }} X25519 keypair (32 bytes each)
 */
export function deriveX25519Keys(ed25519SecretKey) {
  const x25519Pk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const x25519Sk = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)

  // Extract Ed25519 public key from secret key (last 32 bytes)
  const ed25519Pk = ed25519SecretKey.subarray(32, 64)

  // Convert Ed25519 keys to X25519
  sodium.crypto_sign_ed25519_pk_to_curve25519(x25519Pk, ed25519Pk)
  sodium.crypto_sign_ed25519_sk_to_curve25519(x25519Sk, ed25519SecretKey)

  return { publicKey: x25519Pk, secretKey: x25519Sk }
}

/**
 * Convert Ed25519 public key to X25519 public key
 * @param {Buffer} ed25519PublicKey - 32-byte Ed25519 public key
 * @returns {Buffer} 32-byte X25519 public key
 */
export function ed25519PkToX25519(ed25519PublicKey) {
  const x25519Pk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(x25519Pk, ed25519PublicKey)
  return x25519Pk
}

/**
 * Derive a shared symmetric key for a DM conversation
 * Both parties derive the same key using X25519 Diffie-Hellman + hash
 * @param {Buffer} theirEd25519Pk - Other party's Ed25519 public key (32 bytes)
 * @param {Buffer} myX25519Sk - My X25519 secret key (32 bytes)
 * @returns {Buffer} 32-byte shared key for symmetric encryption
 */
export function deriveSharedKey(theirEd25519Pk, myX25519Sk) {
  // Convert their Ed25519 public key to X25519
  const theirX25519Pk = ed25519PkToX25519(theirEd25519Pk)

  // Compute raw Diffie-Hellman shared secret
  const rawShared = b4a.alloc(sodium.crypto_scalarmult_BYTES)
  sodium.crypto_scalarmult(rawShared, myX25519Sk, theirX25519Pk)

  // Hash the raw shared secret to derive a proper symmetric key
  // Include a domain separator to prevent misuse
  const prefix = b4a.from('swarmnero-dm-shared-v1')
  const input = b4a.concat([prefix, rawShared])
  const sharedKey = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_generichash(sharedKey, input)

  return sharedKey
}

/**
 * Encrypt a message using shared symmetric key (XSalsa20-Poly1305)
 * Both parties can encrypt/decrypt since they share the same key
 * @param {string} plaintext - Message to encrypt
 * @param {Buffer} sharedKey - 32-byte shared symmetric key
 * @returns {{ nonce: string, ciphertext: string }} Encrypted message with hex-encoded nonce and ciphertext
 */
export function encryptMessage(plaintext, sharedKey) {
  // Generate random nonce
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  // Prepare plaintext buffer
  const plaintextBuf = b4a.from(plaintext, 'utf8')

  // Encrypt with crypto_secretbox_easy (symmetric encryption)
  const ciphertext = b4a.alloc(plaintextBuf.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, plaintextBuf, nonce, sharedKey)

  return {
    nonce: b4a.toString(nonce, 'hex'),
    ciphertext: b4a.toString(ciphertext, 'hex')
  }
}

/**
 * Decrypt a message using shared symmetric key (XSalsa20-Poly1305)
 * Both parties can decrypt since they share the same key
 * @param {{ nonce: string, ciphertext: string }} encrypted - Encrypted message with hex-encoded nonce and ciphertext
 * @param {Buffer} sharedKey - 32-byte shared symmetric key
 * @returns {string|null} Decrypted plaintext, or null if decryption failed
 */
export function decryptMessage(encrypted, sharedKey) {
  try {
    // Decode nonce and ciphertext
    const nonce = b4a.from(encrypted.nonce, 'hex')
    const ciphertext = b4a.from(encrypted.ciphertext, 'hex')

    // Decrypt with crypto_secretbox_open_easy (symmetric decryption)
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
    const success = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, sharedKey)

    if (!success) {
      return null
    }

    return plaintext.toString('utf8')
  } catch (err) {
    console.error('DM decryption error:', err.message)
    return null
  }
}

/**
 * Derive deterministic DM key from two public keys
 * Both parties will derive the same key regardless of order
 * @param {string} myPubkeyHex - My Ed25519 public key (hex)
 * @param {string} theirPubkeyHex - Their Ed25519 public key (hex)
 * @returns {Buffer} 32-byte deterministic key for Autobase discovery
 */
export function deriveDMKey(myPubkeyHex, theirPubkeyHex) {
  // Sort pubkeys to ensure both parties derive same key
  const sorted = [myPubkeyHex, theirPubkeyHex].sort()

  // Create input buffer: prefix + sorted pubkeys
  const prefix = b4a.from('swarmnero-dm-v1')
  const pk1 = b4a.from(sorted[0], 'hex')
  const pk2 = b4a.from(sorted[1], 'hex')
  const input = b4a.concat([prefix, pk1, pk2])

  // Hash to derive 32-byte key
  const key = b4a.alloc(32)
  sodium.crypto_generichash(key, input)

  return key
}

/**
 * Hash a pubkey for target matching in dm_invite events
 * This hides the actual target pubkey in the public feed
 * @param {string} pubkeyHex - Ed25519 public key (hex)
 * @returns {string} Hex-encoded hash
 */
export function hashTargetPubkey(pubkeyHex) {
  const prefix = b4a.from('swarmnero-dm-invite-v1')
  const pk = b4a.from(pubkeyHex, 'hex')
  const input = b4a.concat([prefix, pk])

  const hash = b4a.alloc(32)
  sodium.crypto_generichash(hash, input)

  return b4a.toString(hash, 'hex')
}

/**
 * Seal a message for a recipient using crypto_box_seal (anonymous encryption)
 * Only the recipient can decrypt using their secret key
 * @param {Buffer} message - Message to encrypt
 * @param {Buffer} recipientEd25519Pk - Recipient's Ed25519 public key (32 bytes)
 * @returns {string} Hex-encoded sealed ciphertext
 */
export function sealForRecipient(message, recipientEd25519Pk) {
  // Convert Ed25519 public key to X25519 for crypto_box
  const recipientX25519Pk = ed25519PkToX25519(recipientEd25519Pk)

  // Allocate output buffer: ciphertext = message + SEALBYTES overhead
  const ciphertext = b4a.alloc(message.length + sodium.crypto_box_SEALBYTES)

  // Seal the message
  sodium.crypto_box_seal(ciphertext, message, recipientX25519Pk)

  return b4a.toString(ciphertext, 'hex')
}

/**
 * Unseal a message encrypted with crypto_box_seal
 * @param {string} ciphertextHex - Hex-encoded sealed ciphertext
 * @param {{ publicKey: Buffer, secretKey: Buffer }} x25519Keypair - Recipient's X25519 keypair
 * @returns {Buffer|null} Decrypted message buffer, or null if decryption failed
 */
export function unseal(ciphertextHex, x25519Keypair) {
  try {
    const ciphertext = b4a.from(ciphertextHex, 'hex')

    // Ciphertext must be at least SEALBYTES long
    if (ciphertext.length < sodium.crypto_box_SEALBYTES) {
      return null
    }

    // Allocate output buffer
    const plaintext = b4a.alloc(ciphertext.length - sodium.crypto_box_SEALBYTES)

    // Unseal the message
    const success = sodium.crypto_box_seal_open(
      plaintext,
      ciphertext,
      x25519Keypair.publicKey,
      x25519Keypair.secretKey
    )

    if (!success) {
      return null
    }

    return plaintext
  } catch (err) {
    console.error('Unseal error:', err.message)
    return null
  }
}

/**
 * Derive a deterministic 32-byte symmetric key from the user's own Ed25519 secret key.
 * Used to encrypt private_data events stored in the user's own feed (e.g. paywall unlocks).
 * Only the user can derive this key — followers replicating the feed cannot.
 * @param {Buffer} ed25519SecretKey - 64-byte Ed25519 secret key
 * @returns {Buffer} 32-byte symmetric key for crypto_secretbox
 */
export function deriveLocalStorageKey(ed25519SecretKey) {
  const prefix = b4a.from('swarmnero-private-storage-v1')
  const input = b4a.concat([prefix, ed25519SecretKey])
  const key = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.crypto_generichash(key, input)
  return key
}

/**
 * Derive mailbox topic from pubkey
 * Used for real-time knock notifications
 * @param {string} pubkeyHex - Ed25519 public key (hex)
 * @returns {Buffer} 32-byte topic for swarm join
 */
export function deriveMailboxTopic(pubkeyHex) {
  const prefix = b4a.from('swarmnero-mailbox-v1')
  const pk = b4a.from(pubkeyHex, 'hex')
  const input = b4a.concat([prefix, pk])

  const topic = b4a.alloc(32)
  sodium.crypto_generichash(topic, input)

  return topic
}
