// Spike v5: Same-store in-place upgrade.
//
// On a real user's device, the Corestore already exists. We need to:
//   1. Open the legacy core via {name: ...}
//   2. Extract its keypair
//   3. Close it; reopen via {keyPair: ...} in the SAME store
//   4. Verify: same key, same history visible, still writable
//
// If this works, v0.9.0 can do a one-time in-place upgrade with
// zero data movement.

import Corestore from 'corestore'
import sodium from 'sodium-native'
import b4a from 'b4a'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-inplace-'))
console.log('tmpdir:', TMP, '\n')

// Seed: realistic setup — identity pubkey drives the legacy `name`
const idPub = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
const idSec = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
sodium.crypto_sign_keypair(idPub, idSec)
const name = 'feed-' + b4a.toString(idPub, 'hex')

const storeDir = path.join(TMP, 'user-pear-storage')
const store = new Corestore(storeDir)
await store.ready()

// --- Pre-upgrade: write some data via legacy {name} ---
console.log('--- Pre-upgrade ---')
let core = store.get({ name })
await core.ready()
await core.append(b4a.from(JSON.stringify({ type: 'profile', name: 'Alice' })))
await core.append(b4a.from(JSON.stringify({ type: 'post', content: 'hello' })))
await core.append(b4a.from(JSON.stringify({ type: 'follow', swarmId: 'abc123' })))
const legacyKey = b4a.toString(core.key, 'hex')
const extractedKP = {
  publicKey: b4a.from(core.keyPair.publicKey),
  secretKey: b4a.from(core.keyPair.secretKey)
}
console.log('core.key       :', legacyKey)
console.log('blocks written :', core.length)
console.log('kp.publicKey   :', b4a.toString(extractedKP.publicKey, 'hex'))

await core.close()

// --- Upgrade: reopen same store via {keyPair} ---
console.log('\n--- In-place upgrade: reopen via {keyPair} ---')
const upgraded = store.get({ keyPair: extractedKP })
await upgraded.ready()
console.log('core.key       :', b4a.toString(upgraded.key, 'hex'))
console.log('matches legacy :', legacyKey === b4a.toString(upgraded.key, 'hex') ? 'YES' : 'NO')
console.log('blocks visible :', upgraded.length, '(expected 3)')
console.log('writable       :', upgraded.writable)

// Read each block back
for (let i = 0; i < upgraded.length; i++) {
  const block = await upgraded.get(i)
  console.log(`  block ${i}:`, block.toString())
}

// Try a new append to verify writes still sign correctly
await upgraded.append(b4a.from(JSON.stringify({ type: 'post', content: 'post-after-upgrade' })))
console.log('post-upgrade append: block', upgraded.length - 1, '= ok')
await upgraded.close()

// --- Sanity: close + reopen again, this time ONLY via {keyPair} ---
console.log('\n--- Relaunch simulation: pure {keyPair} lookup ---')
const again = store.get({ keyPair: extractedKP })
await again.ready()
console.log('core.key       :', b4a.toString(again.key, 'hex'))
console.log('matches legacy :', legacyKey === b4a.toString(again.key, 'hex') ? 'YES' : 'NO')
console.log('blocks visible :', again.length, '(expected 4)')
const lastBlock = await again.get(again.length - 1)
console.log('last block     :', lastBlock.toString())
await again.close()

await store.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n✓ DONE')
