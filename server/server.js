/**
 * Swarmnero Sync Server
 *
 * Always-online Hyperswarm peer that replicates supporter feeds.
 * Supporters pay $12/year in XMR for 100MB of feed storage.
 */

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { SyncFeed } from './lib/sync-feed.js'
import { SyncManager } from './lib/sync-manager.js'
import { SyncProtocol } from './lib/sync-protocol.js'
import { SyncWallet } from './lib/sync-wallet.js'
import { Identity } from './lib/identity.js'
import { PriceOracle } from './lib/price-oracle.js'
import { ConsumedTxs } from './lib/consumed-txs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true })

// Intervals
const PAYMENT_CHECK_INTERVAL = 5 * 60 * 1000     // 5 minutes
const EXPIRY_CHECK_INTERVAL = 60 * 60 * 1000      // 1 hour
const STORAGE_AUDIT_INTERVAL = 30 * 1000         // 30 seconds — tight loop so
                                                  // a spammy supporter can't accumulate
                                                  // gigabytes before we react

async function main() {
  console.log('=== Swarmnero Sync Server ===')
  console.log(`Data directory: ${DATA_DIR}`)

  // Load or create server identity
  const identity = new Identity(DATA_DIR)
  await identity.loadOrCreate()
  console.log(`Server identity: ${identity.pubkeyHex}`)

  // Initialize feed (Corestore + Hyperswarm)
  const syncFeed = new SyncFeed(DATA_DIR)
  await syncFeed.init(identity)

  // Initialize account manager
  const syncManager = new SyncManager(DATA_DIR)
  syncManager.load()

  // Price oracle — CoinGecko primary, Kraken backup
  const priceOracle = new PriceOracle()
  try {
    await priceOracle.init()
  } catch (err) {
    console.warn('[Server] Price oracle init failed, will retry on demand:', err.message)
  }

  // Consumed tx set for replay protection
  const consumedTxs = new ConsumedTxs(DATA_DIR)
  consumedTxs.load()

  // Initialize Protomux protocol handler BEFORE wallet (so it's ready for connections)
  let syncWallet = null
  const syncProtocol = new SyncProtocol({
    syncFeed,
    syncManager,
    syncWallet,
    priceOracle,
    consumedTxs,
    identity
  })
  syncProtocol.init()

  // Connect to monero-wallet-rpc (must be running as separate service)
  try {
    syncWallet = new SyncWallet()
    await syncWallet.init()
    // Update protocol with wallet reference
    syncProtocol.syncWallet = syncWallet
    console.log('Wallet RPC connected')
  } catch (err) {
    console.error('Wallet RPC not available:', err.message)
    console.log('Server will run without wallet - payment verification disabled')
    console.log('Ensure monero-wallet-rpc is running on 127.0.0.1:18083')
  }

  // Follow all active supporters' feeds
  const activeAccounts = syncManager.getActiveAccounts()
  console.log(`Following ${activeAccounts.length} active supporter feeds...`)

  for (const { swarmId } of activeAccounts) {
    try {
      await syncFeed.follow(swarmId)
    } catch (err) {
      console.error(`Error following ${swarmId.slice(0, 16)}:`, err.message)
    }
  }

  // Periodic: Check for new payments (covers case where client paid but
  // never submitted sync_payment_proof — still requires sufficient amount
  // and consumed-tx check)
  if (syncWallet) {
    setInterval(async () => {
      try {
        await syncWallet.sync()
        const payments = await syncWallet.checkPayments(syncManager)

        for (const { pubkey, amount, txHash } of payments) {
          if (consumedTxs.has(txHash)) continue

          const account = syncManager.getAccount(pubkey)
          if (!account) continue

          // Block poll-route reactivation for lapsed or capped accounts.
          // Renewal must go through authenticated sync_payment_proof so an
          // attacker can't revive someone else's account by paying to their
          // old subaddress.
          if (!syncManager.canReactivateViaPoll(pubkey)) {
            console.warn(`[Payment] Poll: skipping reactivation for ${pubkey.slice(0, 8)}... (expired or capped)`)
            continue
          }

          const receivedAtomic = BigInt(amount)
          if (!syncManager.isPaymentSufficient(pubkey, receivedAtomic)) {
            console.warn(`[Payment] Poll: short payment for ${pubkey.slice(0, 8)}... received=${amount}`)
            continue
          }

          console.log(`[Payment] Poll: activating ${pubkey.slice(0, 8)}... amount=${amount}`)
          consumedTxs.add(txHash)
          syncManager.activateAccount(pubkey, txHash, amount)
          await syncFeed.follow(account.swarmId)
        }
      } catch (err) {
        console.error('[Payment] Check error:', err.message)
      }
    }, PAYMENT_CHECK_INTERVAL)
  }

  // Periodic: Check expiry
  setInterval(async () => {
    const { expired, graceExpired } = syncManager.checkExpiry()

    for (const pubkey of graceExpired) {
      const account = syncManager.getAccount(pubkey)
      if (account) {
        console.log(`[Expiry] Cleaning up expired account: ${pubkey.slice(0, 16)}...`)
        await syncFeed.unfollow(account.swarmId)
        syncManager.removeAccount(pubkey)
      }
    }

    if (expired.length > 0) {
      console.log(`[Expiry] ${expired.length} accounts in grace period`)
    }
  }, EXPIRY_CHECK_INTERVAL)

  // Periodic: Storage audit — runs every 30s and actively enforces the cap
  setInterval(async () => {
    for (const { pubkey, swarmId } of syncManager.getActiveAccounts()) {
      const bytes = syncFeed.getStorageUsed(swarmId)
      syncManager.updateStorageUsage(pubkey, bytes)

      if (syncManager.isOverStorageCap(pubkey)) {
        const mb = (bytes / 1024 / 1024).toFixed(1)
        console.warn(`[Storage] ENFORCE cap for ${pubkey.slice(0, 16)}... (${mb}MB) — clearing and unfollowing`)
        try {
          await syncFeed.clearStorage(swarmId)
        } catch (err) {
          console.error(`[Storage] clearStorage failed for ${pubkey.slice(0, 16)}:`, err.message)
        }
        syncManager.markOverCap(pubkey)
      }
    }
  }, STORAGE_AUDIT_INTERVAL)

  // Log server info
  console.log('')
  console.log('Server running.')
  console.log(`Swarm ID: ${syncFeed.swarmId}`)
  console.log(`Active supporters: ${activeAccounts.length}`)
  if (syncWallet) {
    const address = await syncWallet.getAddress()
    console.log(`Wallet address: ${address}`)
  }
  console.log('')
  console.log('Waiting for connections...')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...')
    syncProtocol.close()
    priceOracle.close()
    if (syncWallet) await syncWallet.close()
    await syncFeed.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
