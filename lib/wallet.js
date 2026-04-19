/**
 * Swarmnero Wallet - Core Monero wallet operations
 *
 * Wraps monero-ts library for wallet lifecycle management.
 * Per-account wallets with 15-minute auto-lock timeout.
 * Uses mainnet network with delta sync and cache support.
 */

import moneroTs from 'monero-ts'
import * as walletStorage from './wallet-storage.js'
import * as nodeSelector from './node-selector.js'

// Module state
let currentWallet = null       // MoneroWalletFull instance
let currentAccountName = null
let isUnlocked = false
let unlockTimeout = null
let decryptedSeed = null
let currentWalletPassword = null  // Stored for binary wallet persistence
let pendingTx = null
const UNLOCK_TIMEOUT_MS = 15 * 60 * 1000
let DATA_DIR = './pear/data'   // Default, should be set via setDataDir()

// Background sync state
let backgroundSyncInterval = null
let lastKnownBalance = null
let lastKnownUnlockedBalance = null
let isSyncing = false
let lastSyncTime = null
let lastSyncHeight = null
const BACKGROUND_SYNC_INTERVAL_MS = 60 * 1000  // 60 seconds

// Current sync progress (updated during sync for UI)
let currentSyncProgress = {
  height: 0,
  startHeight: 0,
  endHeight: 0,
  percentDone: 0,
  isConnected: false,
  nodeUrl: null
}

// Balance change callback
let balanceChangeCallback = null

// Sync complete callbacks (called after every background sync)
let syncCompleteCallbacks = []

// Cached sync data (loaded from storage on unlock, updated after sync)
let cachedBalance = null       // { confirmed: bigint, unconfirmed: bigint }
let cachedTxHistory = null     // Array of transaction objects
let hasSyncedThisSession = false  // Track if we've synced since unlock

// Outgoing tip mappings: txHash -> { pubkey, timestamp } of the post that was tipped
let outgoingTipPosts = new Map()

/**
 * Set the data directory for wallet storage
 * Must be called before any wallet operations
 * @param {string} dataDir - Data directory path
 */
export function setDataDir(dataDir) {
  DATA_DIR = dataDir
}

// Default remote nodes for mainnet
const DEFAULT_NODES = [
  'https://node.sethforprivacy.com:443',
  'https://xmr-node.cakewallet.com:18081',
  'https://node.community.rino.io:18081',
  'https://nodes.hashvault.pro:18081',
  // Additional fallback nodes for improved reliability
  'https://xmr.0xrpc.io:443',
  'https://public-monero-node.xyz:443',
  'https://kowalski.fiatfaucet.com:443',
  'https://xmr.europeanmonero.observer:443',
  'https://xmr.ci.vet:443',
  'https://xmr.thinhhv.com:443'
]

/**
 * Reset the auto-lock timeout
 */
function resetUnlockTimeout() {
  if (unlockTimeout) {
    clearTimeout(unlockTimeout)
  }
  unlockTimeout = setTimeout(() => {
    lock()
  }, UNLOCK_TIMEOUT_MS)
}

/**
 * Merge cached transaction history with new transactions
 * Uses txid as unique key, new transactions overwrite cached ones (for updated confirmations)
 * @param {Array} cached - Previously cached transactions
 * @param {Array} newTxs - Newly synced transactions
 * @returns {Array} Merged and sorted transactions
 */
function mergeTransactionHistory(cached, newTxs) {
  const txMap = new Map()

  // Add cached transactions first
  if (cached && Array.isArray(cached)) {
    cached.forEach(tx => {
      if (tx.txid) {
        txMap.set(tx.txid, tx)
      }
    })
  }

  // New transactions overwrite cached (they have updated confirmations)
  if (newTxs && Array.isArray(newTxs)) {
    newTxs.forEach(tx => {
      if (tx.txid) {
        txMap.set(tx.txid, tx)
      }
    })
  }

  // Convert to array and sort by timestamp (newest first)
  return Array.from(txMap.values()).sort((a, b) => {
    const aTime = a.timestamp || (a.height ? a.height * 120 : 0)
    const bTime = b.timestamp || (b.height ? b.height * 120 : 0)
    return bTime - aTime
  })
}

/**
 * Save current wallet sync data (balance + txHistory) to storage
 * Called after each sync completes
 */
async function saveSyncData() {
  if (!currentAccountName || !currentWallet) {
    return
  }

  try {
    // Get current balance
    const balance = await currentWallet.getBalance()
    const unlockedBalance = await currentWallet.getUnlockedBalance()

    // Get transaction history (using the wallet directly to get fresh data)
    let txs = []
    try {
      txs = await currentWallet.getTxs()
    } catch (e) {
      console.warn('[Wallet] Error getting transactions for save:', e.message)
    }

    // Process transactions to our format
    // Key insight: A transaction can have BOTH incoming (change) AND outgoing components
    // When sending XMR, change comes back as an incoming transfer in the SAME transaction
    // We classify such transactions as OUTGOING with the NET amount sent
    const txHistory = (txs || []).map(tx => {
      const getValue = (obj, methodName, propName) => {
        if (typeof obj[methodName] === 'function') return obj[methodName]()
        if (propName && obj[propName] !== undefined) return obj[propName]
        return undefined
      }

      const txid = getValue(tx, 'getHash', 'hash')
      const height = getValue(tx, 'getHeight', 'height')
      const timestamp = getValue(tx, 'getTimestamp', 'timestamp')
      const fee = getValue(tx, 'getFee', 'fee')
      const confirmations = getValue(tx, 'getNumConfirmations', 'numConfirmations') || 0

      const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers')
      const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer')
      const hasIncoming = incomingTransfers && incomingTransfers.length > 0
      const hasOutgoing = outgoingTransfer !== undefined && outgoingTransfer !== null

      // Classification logic:
      // - If transaction has outgoing transfer, classify as OUTGOING (even if it also has change)
      // - Only classify as INCOMING if it has NO outgoing transfer (pure receive)
      const isOutgoing = hasOutgoing
      const isIncoming = hasIncoming && !hasOutgoing

      let amount = 0n
      let subaddressIndices = []

      if (isOutgoing) {
        // For outgoing transactions, use outgoingAmount which is the NET amount sent
        // (excludes change that comes back to us)
        const outAmount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount')
        amount = outAmount ? BigInt(outAmount.toString()) : 0n
      } else if (isIncoming) {
        // For pure incoming transactions (no outgoing component), use incomingAmount
        const inAmount = getValue(tx, 'getIncomingAmount', 'incomingAmount')
        amount = inAmount ? BigInt(inAmount.toString()) : 0n

        // Extract subaddress indices for incoming transactions (for post linking)
        if (incomingTransfers && incomingTransfers.length > 0) {
          const subaddrSet = new Set()
          for (const transfer of incomingTransfers) {
            const getTransferValue = (obj, method, prop) => {
              if (typeof obj[method] === 'function') return obj[method]()
              if (prop && obj[prop] !== undefined) return obj[prop]
              return undefined
            }
            const subaddrIndex = getTransferValue(transfer, 'getSubaddressIndex', 'subaddressIndex')
            if (subaddrIndex !== undefined && subaddrIndex !== null) {
              subaddrSet.add(subaddrIndex)
            }
          }
          subaddressIndices = Array.from(subaddrSet)
        }
      }

      return {
        txid,
        height,
        timestamp,
        isIncoming,
        isOutgoing,
        amount,
        fee: fee ? BigInt(fee.toString()) : 0n,
        confirmations,
        subaddressIndices
      }
    })

    // Merge new transactions with cached (preserves history from before delta sync)
    const mergedTxHistory = mergeTransactionHistory(cachedTxHistory, txHistory)

    // Save to storage
    walletStorage.saveWalletSyncData(DATA_DIR, currentAccountName, {
      balance: {
        confirmed: BigInt(balance.toString()),
        unconfirmed: BigInt(unlockedBalance.toString())
      },
      txHistory: mergedTxHistory
    })

    // Update cached values
    cachedBalance = {
      confirmed: BigInt(balance.toString()),
      unconfirmed: BigInt(unlockedBalance.toString())
    }
    cachedTxHistory = mergedTxHistory
    hasSyncedThisSession = true

    console.log('[Wallet] Saved sync data:', mergedTxHistory.length, 'transactions (', txHistory.length, 'new )')
  } catch (e) {
    console.error('[Wallet] Failed to save sync data:', e.message, e.stack)
  }
}

/**
 * Save wallet binary state (keysData + cacheData) to storage
 * This preserves outputs and key images for proper delta sync on next open
 * Called after sync completes and before locking
 */
async function saveWalletState() {
  if (!currentWallet || !currentAccountName || !currentWalletPassword) {
    console.log('[Wallet] Cannot save wallet state: missing wallet, account, or password')
    return
  }

  try {
    // Get binary wallet data (keysData and cacheData)
    const data = await currentWallet.getData()
    if (!data || data.length !== 2) {
      console.warn('[Wallet] getData() did not return expected [keysData, cacheData]')
      return
    }

    const [keysData, cacheData] = data

    // Save encrypted binary data
    await walletStorage.saveWalletBinaryData(
      DATA_DIR,
      currentAccountName,
      keysData,
      cacheData,
      currentWalletPassword
    )

    console.log('[Wallet] Saved wallet binary state (keys:', keysData.length, 'bytes, cache:', cacheData.length, 'bytes)')
  } catch (e) {
    console.error('[Wallet] Failed to save wallet state:', e.message)
  }
}

/**
 * Load cached sync data from storage
 * Called when unlocking wallet before sync
 */
function loadCachedSyncData() {
  if (!currentAccountName) {
    return
  }

  const savedData = walletStorage.getWalletSyncData(DATA_DIR, currentAccountName)
  if (savedData) {
    cachedBalance = savedData.balance
    cachedTxHistory = savedData.txHistory
    console.log('[Wallet] Loaded cached sync data:', cachedTxHistory?.length || 0, 'transactions')
  } else {
    cachedBalance = null
    cachedTxHistory = null
    console.log('[Wallet] No cached sync data found')
  }
}

/**
 * Try to connect to the fastest remote node
 * Tests all nodes in parallel and selects the fastest one
 * @returns {Promise<string>} URI of fastest working node
 */
async function findWorkingNode() {
  // First check if we already have a selected node
  const cached = nodeSelector.getSelectedNode()
  if (cached) {
    console.log('[Wallet] Using cached node:', cached.url, `(${cached.latency}ms)`)
    return cached.url
  }

  // Test all nodes and select fastest
  const fastest = await nodeSelector.selectFastestNode(DEFAULT_NODES)

  if (!fastest) {
    throw new Error('Could not connect to any Monero node')
  }

  console.log('[Wallet] Selected fastest node:', fastest.url, `(${fastest.latency}ms)`)
  return fastest.url
}

/**
 * Check if a wallet exists for an account
 * @param {string} accountName - Account name
 * @returns {Promise<boolean>}
 */
export async function hasWallet(accountName) {
  return walletStorage.walletExists(DATA_DIR, accountName)
}

/**
 * Create a new wallet for an account
 * @param {string} accountName - Account name
 * @param {string} password - Password to encrypt wallet
 * @returns {Promise<{seed: string, address: string, restoreHeight: number}>}
 */
export async function createWallet(accountName, password) {
  if (!accountName || typeof accountName !== 'string') {
    throw new Error('Account name is required')
  }
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required')
  }

  // Check if wallet already exists
  if (await hasWallet(accountName)) {
    throw new Error('Wallet already exists for this account')
  }

  // Create keys-only wallet (fast, no sync needed)
  const wallet = await moneroTs.createWalletKeys({
    networkType: moneroTs.MoneroNetworkType.MAINNET,
    language: 'English'
  })

  try {
    // Extract wallet data
    const seed = await wallet.getSeed()
    const address = await wallet.getPrimaryAddress()

    // Get current block height from network for accurate restore height
    let restoreHeight
    try {
      const nodeUrl = await findWorkingNode()
      const daemon = await moneroTs.connectToDaemonRpc(nodeUrl)
      const currentHeight = await daemon.getHeight()
      // Subtract a small buffer (10 blocks) for safety
      restoreHeight = Math.max(0, currentHeight - 10)
      console.log('[Wallet] Got current height from network:', currentHeight, '-> restore height:', restoreHeight)
    } catch (e) {
      throw new Error('Network unavailable - cannot create wallet without connection to Monero network')
    }

    // Save encrypted wallet
    await walletStorage.saveWallet(DATA_DIR, accountName, {
      seed,
      primaryAddress: address,
      restoreHeight
    }, password)

    // Auto-unlock after creation
    currentAccountName = accountName
    decryptedSeed = seed
    currentWalletPassword = password
    isUnlocked = true
    resetUnlockTimeout()

    return { seed, address, restoreHeight }
  } finally {
    await wallet.close()
  }
}

/**
 * Restore a wallet from seed phrase
 * @param {string} accountName - Account name
 * @param {string} seed - 25-word seed phrase
 * @param {string} password - Password to encrypt wallet
 * @param {number} restoreHeight - Block height to start scanning from
 * @returns {Promise<{address: string}>}
 */
export async function restoreWallet(accountName, seed, password, restoreHeight = 0) {
  if (!accountName || typeof accountName !== 'string') {
    throw new Error('Account name is required')
  }
  if (!seed || typeof seed !== 'string') {
    throw new Error('Seed phrase is required')
  }
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required')
  }

  // Validate seed format
  const words = seed.trim().split(/\s+/)
  if (words.length !== 25) {
    throw new Error('Seed phrase must be exactly 25 words')
  }

  // Validate restore height
  if (typeof restoreHeight !== 'number' || restoreHeight < 0) {
    throw new Error('Restore height must be a non-negative number')
  }

  // Check if wallet already exists
  if (await hasWallet(accountName)) {
    throw new Error('Wallet already exists for this account')
  }

  // Create keys-only wallet from seed
  const wallet = await moneroTs.createWalletKeys({
    networkType: moneroTs.MoneroNetworkType.MAINNET,
    seed: seed.trim()
  })

  try {
    const address = await wallet.getPrimaryAddress()

    // Save encrypted wallet
    await walletStorage.saveWallet(DATA_DIR, accountName, {
      seed: seed.trim(),
      primaryAddress: address,
      restoreHeight
    }, password)

    // Auto-unlock after restore
    currentAccountName = accountName
    decryptedSeed = seed.trim()
    currentWalletPassword = password
    isUnlocked = true
    resetUnlockTimeout()

    return { address }
  } finally {
    await wallet.close()
  }
}

/**
 * Unlock a wallet with password
 * @param {string} accountName - Account name
 * @param {string} password - Password to decrypt wallet
 * @returns {Promise<boolean>}
 */
export async function unlock(accountName, password) {
  if (!accountName || typeof accountName !== 'string') {
    throw new Error('Account name is required')
  }
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required')
  }

  // Check if wallet exists
  if (!(await hasWallet(accountName))) {
    throw new Error('No wallet found for this account')
  }

  // Load and decrypt wallet data
  const walletData = await walletStorage.loadWallet(DATA_DIR, accountName, password)

  // Store decrypted seed and password (for binary wallet persistence)
  currentAccountName = accountName
  decryptedSeed = walletData.seed
  currentWalletPassword = password
  isUnlocked = true
  hasSyncedThisSession = false
  resetUnlockTimeout()

  // Load cached sync data (balance + txHistory) for immediate display
  loadCachedSyncData()

  // Load outgoing tip mappings
  loadTipMappings()

  // Load announced tips (tips we've already published tip_received events for)
  loadAnnouncedTips()

  // NOTE: Don't start background sync here - let UI do initial sync with progress first
  // UI should call startBackgroundSync() after initial sync completes

  return true
}

/**
 * Lock the wallet (clear decrypted data from memory)
 */
export async function lock() {
  // Stop background sync first
  stopBackgroundSync()

  if (unlockTimeout) {
    clearTimeout(unlockTimeout)
    unlockTimeout = null
  }

  // Save wallet binary state before closing (if wallet is open)
  if (currentWallet) {
    try {
      await saveWalletState()
    } catch (e) {
      console.warn('[Wallet] Failed to save wallet state on lock:', e.message)
    }
  }

  // Close any open full wallet
  if (currentWallet) {
    currentWallet.close().catch(() => {})
    currentWallet = null
  }

  // Clear decrypted data including password
  decryptedSeed = null
  currentWalletPassword = null
  isUnlocked = false
  currentAccountName = null
  pendingTx = null

  // Reset background sync state
  lastKnownBalance = null
  lastKnownUnlockedBalance = null
  isSyncing = false

  // Clear cached sync data
  cachedBalance = null
  cachedTxHistory = null
  hasSyncedThisSession = false

  // Clear tip mappings
  outgoingTipPosts = new Map()

  // Clear announced tips (will be reloaded on next unlock)
  announcedTipTxids = new Set()
}

/**
 * Check if wallet is currently unlocked
 * @returns {boolean}
 */
export function isWalletUnlocked() {
  return isUnlocked && decryptedSeed !== null
}

/**
 * Get primary address for an account (available even when locked)
 * @param {string} accountName - Account name
 * @returns {Promise<string|null>}
 */
export async function getPrimaryAddress(accountName) {
  if (!(await hasWallet(accountName))) {
    return null
  }
  const meta = walletStorage.getWalletMeta(DATA_DIR, accountName)
  return meta?.primaryAddress || null
}

/**
 * Get wallet metadata (available even when locked)
 * @param {string} accountName - Account name
 * @returns {Promise<{primaryAddress: string, restoreHeight: number, lastSyncedHeight: number|null}|null>}
 */
export async function getWalletMeta(accountName) {
  if (!(await hasWallet(accountName))) {
    return null
  }
  return walletStorage.getWalletMeta(DATA_DIR, accountName)
}

/**
 * Get wallet balance (requires unlock)
 * Returns cached balance immediately if available (before sync completes)
 * @returns {Promise<{balance: bigint, unlockedBalance: bigint}>}
 */
export async function getBalance() {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()

  // If we haven't synced yet this session but have cached balance, return it immediately
  // This provides instant UI display while delta sync is in progress
  if (!hasSyncedThisSession && cachedBalance) {
    console.log('[Wallet] Returning cached balance')
    return {
      balance: cachedBalance.confirmed,
      unlockedBalance: cachedBalance.unconfirmed
    }
  }

  // Ensure we have a full wallet instance
  await ensureFullWallet()

  const balance = await currentWallet.getBalance()
  const unlockedBalance = await currentWallet.getUnlockedBalance()

  return {
    balance: BigInt(balance.toString()),
    unlockedBalance: BigInt(unlockedBalance.toString())
  }
}

/**
 * Get a receive address
 * @param {boolean} newSubaddress - Generate new subaddress if true
 * @returns {Promise<{address: string, index?: number}>}
 */
export async function getReceiveAddress(newSubaddress = false) {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()

  if (newSubaddress) {
    await ensureFullWallet()
    const subaddress = await currentWallet.createSubaddress(0)
    return {
      address: subaddress.getAddress(),
      index: subaddress.getIndex()
    }
  }

  // Return primary address
  const address = await getPrimaryAddress(currentAccountName)
  return { address }
}

/**
 * Create a transaction (preview before sending)
 * @param {string} address - Destination address
 * @param {bigint} amount - Amount in atomic units
 * @returns {Promise<{fee: bigint, tx: object}>}
 */
export async function createTransaction(address, amount) {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()

  // Validate address
  if (!address || typeof address !== 'string') {
    throw new Error('Invalid address')
  }
  if ((!address.startsWith('4') && !address.startsWith('8')) ||
      (address.length !== 95 && address.length !== 106)) {
    throw new Error('Invalid Monero address format')
  }

  // Validate amount
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new Error('Amount must be a positive bigint')
  }

  await ensureFullWallet()

  // Create transaction without relaying
  const txConfig = new moneroTs.MoneroTxConfig({
    accountIndex: 0,
    address: address,
    amount: amount,
    relay: false
  })

  pendingTx = await currentWallet.createTx(txConfig)

  const fee = typeof pendingTx.getFee === 'function'
    ? pendingTx.getFee()
    : pendingTx.fee

  return {
    fee: BigInt(fee.toString()),
    tx: pendingTx
  }
}

/**
 * Relay (broadcast) the pending transaction
 * @returns {Promise<{txHash: string, txKey: string}>}
 */
export async function relayTransaction() {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  if (!pendingTx) {
    throw new Error('No pending transaction to relay')
  }
  resetUnlockTimeout()

  await ensureFullWallet()

  // Relay the transaction
  await currentWallet.relayTx(pendingTx)

  const txHash = typeof pendingTx.getHash === 'function'
    ? pendingTx.getHash()
    : pendingTx.hash

  // Get tx key for proof of payment
  let txKey = ''
  try {
    txKey = await currentWallet.getTxKey(txHash)
  } catch (e) {
    console.warn('[Wallet] Could not get tx key:', e.message)
  }

  const result = { txHash, txKey }
  pendingTx = null

  return result
}

/**
 * Refresh transaction history immediately after sending
 * Fetches new transactions and merges with cached history
 * @returns {Promise<void>}
 */
export async function refreshAfterSend() {
  if (!isWalletUnlocked()) {
    return
  }

  try {
    await ensureFullWallet()

    // Fetch fresh transactions
    const txs = await currentWallet.getTxs()
    if (!txs || txs.length === 0) return

    // Process transactions (simplified version of getTransactions logic)
    const processed = txs.map(tx => {
      const getValue = (obj, methodName, propName) => {
        if (typeof obj[methodName] === 'function') return obj[methodName]()
        if (propName && obj[propName] !== undefined) return obj[propName]
        return undefined
      }

      const txid = getValue(tx, 'getHash', 'hash')
      const height = getValue(tx, 'getHeight', 'height')
      const timestamp = getValue(tx, 'getTimestamp', 'timestamp')
      const fee = getValue(tx, 'getFee', 'fee')
      const confirmations = getValue(tx, 'getNumConfirmations', 'numConfirmations') || 0

      const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers')
      const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer')
      const hasIncoming = incomingTransfers && incomingTransfers.length > 0
      const hasOutgoing = outgoingTransfer !== undefined && outgoingTransfer !== null

      const isOutgoing = hasOutgoing
      const isIncoming = hasIncoming && !hasOutgoing

      let amount = 0n
      let subaddressIndices = []

      if (isOutgoing) {
        const outAmount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount')
        amount = outAmount ? BigInt(outAmount.toString()) : 0n
      } else if (isIncoming) {
        const inAmount = getValue(tx, 'getIncomingAmount', 'incomingAmount')
        amount = inAmount ? BigInt(inAmount.toString()) : 0n

        // Extract subaddress indices for incoming transactions
        if (incomingTransfers && incomingTransfers.length > 0) {
          const subaddrSet = new Set()
          for (const transfer of incomingTransfers) {
            const getTransferValue = (obj, method, prop) => {
              if (typeof obj[method] === 'function') return obj[method]()
              if (prop && obj[prop] !== undefined) return obj[prop]
              return undefined
            }
            const subaddrIndex = getTransferValue(transfer, 'getSubaddressIndex', 'subaddressIndex')
            if (subaddrIndex !== undefined && subaddrIndex !== null) {
              subaddrSet.add(subaddrIndex)
            }
          }
          subaddressIndices = Array.from(subaddrSet)
        }
      }

      return {
        txid,
        height,
        timestamp,
        isIncoming,
        isOutgoing,
        amount,
        fee: fee ? BigInt(fee.toString()) : 0n,
        confirmations,
        subaddressIndices
      }
    })

    // Merge with cached history
    const merged = mergeTransactionHistory(cachedTxHistory, processed)
    cachedTxHistory = merged

    // Update balance cache too
    try {
      const balance = await currentWallet.getBalance()
      cachedBalance = {
        confirmed: BigInt(balance.toString()),
        unconfirmed: 0n
      }
    } catch (e) {
      console.warn('[Wallet] Could not refresh balance:', e.message)
    }

    // Save to storage
    walletStorage.saveWalletSyncData(DATA_DIR, currentAccountName, {
      balance: cachedBalance || { confirmed: 0n, unconfirmed: 0n },
      txHistory: merged
    })

    console.log('[Wallet] Refreshed after send:', merged.length, 'transactions')
  } catch (e) {
    console.warn('[Wallet] Error refreshing after send:', e.message)
  }
}

/**
 * Cancel the pending transaction
 */
export function cancelPendingTransaction() {
  pendingTx = null
}

/**
 * Ensure daemon connection is active, reconnecting if necessary
 * Tries to reconnect to current node, then falls back to other nodes
 * If all reconnection attempts fail, recreates the wallet instance
 * @returns {Promise<void>}
 */
async function ensureDaemonConnection() {
  if (!currentWallet) {
    return
  }

  // Check if daemon is connected
  let isConnected = false
  try {
    const daemonConnection = await currentWallet.getDaemonConnection()
    if (daemonConnection) {
      // Try to verify the connection is actually working
      await currentWallet.getDaemonHeight()
      isConnected = true
      console.log('[Wallet] Daemon connection verified')
    }
  } catch (e) {
    console.warn('[Wallet] Daemon connection check failed:', e.message)
    isConnected = false
  }

  if (isConnected) {
    return
  }

  // Clear cached node since current connection failed
  nodeSelector.clearSelectedNode()

  // Re-select fastest node
  console.log('[Wallet] Attempting to reconnect to fastest node...')
  const fastest = await nodeSelector.selectFastestNode(DEFAULT_NODES)

  if (fastest) {
    try {
      console.log('[Wallet] Reconnecting to:', fastest.url)
      await currentWallet.setDaemonConnection(fastest.url)
      // Verify the connection works
      await currentWallet.getDaemonHeight()
      console.log('[Wallet] Reconnected to node:', fastest.url, `(${fastest.latency}ms)`)
      return
    } catch (e) {
      console.warn('[Wallet] Failed to reconnect to fastest node:', e.message)
    }
  }

  // If all reconnection attempts failed, close wallet and recreate
  console.log('[Wallet] All reconnection attempts failed, recreating wallet...')
  try {
    await currentWallet.close()
  } catch (e) {
    console.warn('[Wallet] Error closing wallet:', e.message)
  }
  currentWallet = null

  // ensureFullWallet will create a new wallet with a fresh connection
  await ensureFullWallet()
}

/**
 * Sync wallet with blockchain
 * @param {Function} onProgress - Progress callback ({height, startHeight, endHeight, percentDone})
 * @returns {Promise<{height: number}>}
 */
export async function sync(onProgress) {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()

  // Mark as syncing
  isSyncing = true

  // Reset progress
  currentSyncProgress = {
    height: 0,
    startHeight: 0,
    endHeight: 0,
    percentDone: 0,
    isConnected: false,
    nodeUrl: null
  }

  await ensureFullWallet()

  // Ensure daemon connection is active before syncing
  await ensureDaemonConnection()

  // Update connection status
  const nodeInfo = getSelectedNode()
  currentSyncProgress.isConnected = true
  currentSyncProgress.nodeUrl = nodeInfo?.url || null

  // Create sync listener that updates both callback and module state
  class SyncListener extends moneroTs.MoneroWalletListener {
    constructor(progressCallback) {
      super()
      this.progressCallback = progressCallback
    }

    async onSyncProgress(height, startHeight, endHeight, percentDone, message) {
      // Update module state for UI polling
      currentSyncProgress.height = height
      currentSyncProgress.startHeight = startHeight
      currentSyncProgress.endHeight = endHeight
      currentSyncProgress.percentDone = percentDone

      if (this.progressCallback) {
        this.progressCallback({
          height,
          startHeight,
          endHeight,
          percentDone
        })
      }
    }
  }

  const listener = new SyncListener(onProgress)

  try {
    await currentWallet.sync(listener)
  } catch (e) {
    // If sync fails due to connection issues, try to reconnect and retry once
    const errorMessage = e.message || ''
    if (errorMessage.includes('daemon') || errorMessage.includes('connect') ||
        errorMessage.includes('network') || errorMessage.includes('Failed to connect')) {
      console.warn('[Wallet] Sync failed due to connection issue, attempting reconnection:', errorMessage)
      currentSyncProgress.isConnected = false
      await ensureDaemonConnection()
      currentSyncProgress.isConnected = true
      // Retry sync after reconnection
      await currentWallet.sync(listener)
    } else {
      console.error('[Wallet] Sync error:', e)
      isSyncing = false
      throw e
    }
  }

  const height = await currentWallet.getHeight()
  isSyncing = false

  // Save lastSyncedHeight for delta sync on next unlock
  if (currentAccountName) {
    try {
      walletStorage.updateLastSyncedHeight(DATA_DIR, currentAccountName, height)
      console.log('[Wallet] Saved lastSyncedHeight:', height)
    } catch (e) {
      console.warn('[Wallet] Failed to save lastSyncedHeight:', e.message)
    }
  }

  // Save sync data (balance + txHistory) for next unlock
  await saveSyncData()

  // Save wallet binary state (outputs + key images) for proper delta sync
  await saveWalletState()

  console.log('[Wallet] Synced to height:', height)

  return { height }
}

/**
 * Perform a silent background sync
 * Does not throw errors, logs warnings instead
 * Triggers balance change callback if balance changed
 * @returns {Promise<{height: number, balanceChanged: boolean}|null>}
 */
async function backgroundSync() {
  // Don't sync if wallet is locked or already syncing
  if (!isWalletUnlocked() || isSyncing) {
    return null
  }

  isSyncing = true

  // Reset progress
  currentSyncProgress = {
    height: 0,
    startHeight: 0,
    endHeight: 0,
    percentDone: 0,
    isConnected: false,
    nodeUrl: null
  }

  try {
    await ensureFullWallet()

    // Check if wallet was locked during ensureFullWallet
    if (!currentWallet || !isWalletUnlocked()) {
      return null
    }

    // Ensure daemon connection is active before syncing
    await ensureDaemonConnection()

    // Update connection status
    const nodeInfo = getSelectedNode()
    currentSyncProgress.isConnected = true
    currentSyncProgress.nodeUrl = nodeInfo?.url || null

    // Check again before sync
    if (!currentWallet || !isWalletUnlocked()) {
      return null
    }

    // Create progress listener for background sync
    class BackgroundSyncListener extends moneroTs.MoneroWalletListener {
      async onSyncProgress(height, startHeight, endHeight, percentDone, message) {
        currentSyncProgress.height = height
        currentSyncProgress.startHeight = startHeight
        currentSyncProgress.endHeight = endHeight
        currentSyncProgress.percentDone = percentDone
      }
    }

    // Sync with progress tracking
    await currentWallet.sync(new BackgroundSyncListener())

    const height = await currentWallet.getHeight()
    lastSyncHeight = height
    lastSyncTime = Date.now()

    // Save lastSyncedHeight
    if (currentAccountName) {
      try {
        walletStorage.updateLastSyncedHeight(DATA_DIR, currentAccountName, height)
      } catch (e) {
        console.warn('[Wallet] Background sync: failed to save height:', e.message)
      }
    }

    // Check for balance changes
    const balance = await currentWallet.getBalance()
    const unlockedBalance = await currentWallet.getUnlockedBalance()
    const currentBalance = BigInt(balance.toString())
    const currentUnlockedBalance = BigInt(unlockedBalance.toString())

    let balanceChanged = false

    if (lastKnownBalance !== null && lastKnownUnlockedBalance !== null) {
      if (currentBalance !== lastKnownBalance || currentUnlockedBalance !== lastKnownUnlockedBalance) {
        balanceChanged = true
        console.log('[Wallet] Background sync: balance changed')

        // Trigger callback if registered
        if (balanceChangeCallback) {
          try {
            balanceChangeCallback({
              balance: currentBalance,
              unlockedBalance: currentUnlockedBalance,
              previousBalance: lastKnownBalance,
              previousUnlockedBalance: lastKnownUnlockedBalance
            })
          } catch (e) {
            console.warn('[Wallet] Balance change callback error:', e.message)
          }
        }
      }
    }

    // Update last known balances
    lastKnownBalance = currentBalance
    lastKnownUnlockedBalance = currentUnlockedBalance

    // Save sync data (balance + txHistory) for next unlock
    await saveSyncData()

    // Save wallet binary state (outputs + key images) for proper delta sync
    await saveWalletState()

    console.log('[Wallet] Background sync complete, height:', height)

    // Trigger all sync complete callbacks (for UI to update confirmations, announce tips, etc.)
    for (const callback of syncCompleteCallbacks) {
      try {
        await callback({ height, balanceChanged })
      } catch (e) {
        console.warn('[Wallet] Sync complete callback error:', e.message)
      }
    }

    return { height, balanceChanged }
  } catch (e) {
    console.warn('[Wallet] Background sync error:', e.message)
    return null
  } finally {
    isSyncing = false
  }
}

/**
 * Start background sync interval
 * Only runs when wallet is unlocked
 */
export function startBackgroundSync() {
  // Don't start if already running
  if (backgroundSyncInterval) {
    console.log('[Wallet] Background sync already running')
    return
  }

  // Don't start if wallet is locked
  if (!isWalletUnlocked()) {
    console.log('[Wallet] Cannot start background sync: wallet is locked')
    return
  }

  console.log('[Wallet] Starting background sync (interval:', BACKGROUND_SYNC_INTERVAL_MS / 1000, 's)')

  // Run initial sync immediately
  backgroundSync()

  // Set up interval
  backgroundSyncInterval = setInterval(() => {
    if (isWalletUnlocked()) {
      backgroundSync()
    } else {
      // Wallet was locked, stop background sync
      stopBackgroundSync()
    }
  }, BACKGROUND_SYNC_INTERVAL_MS)
}

/**
 * Stop background sync interval
 */
export function stopBackgroundSync() {
  if (backgroundSyncInterval) {
    clearInterval(backgroundSyncInterval)
    backgroundSyncInterval = null
    console.log('[Wallet] Background sync stopped')
  }
}

/**
 * Register a callback for balance changes
 * @param {Function} callback - Called with {balance, unlockedBalance, previousBalance, previousUnlockedBalance}
 */
export function onBalanceChange(callback) {
  if (typeof callback !== 'function') {
    throw new Error('Callback must be a function')
  }
  balanceChangeCallback = callback
}

/**
 * Remove the balance change callback
 */
export function removeBalanceChangeCallback() {
  balanceChangeCallback = null
}

/**
 * Register a callback for sync completion
 * Called after every background sync completes (to update confirmations, etc.)
 * Multiple callbacks can be registered and will be called in order
 * @param {Function} callback - Called with {height, balanceChanged}
 * @returns {Function} Unsubscribe function to remove this callback
 */
export function onSyncComplete(callback) {
  if (typeof callback !== 'function') {
    throw new Error('Callback must be a function')
  }
  syncCompleteCallbacks.push(callback)

  // Return unsubscribe function
  return () => {
    const index = syncCompleteCallbacks.indexOf(callback)
    if (index > -1) {
      syncCompleteCallbacks.splice(index, 1)
    }
  }
}

/**
 * Remove all sync complete callbacks
 */
export function removeAllSyncCompleteCallbacks() {
  syncCompleteCallbacks = []
}

/**
 * Get current sync status for UI
 * @returns {{isSyncing: boolean, lastSyncTime: number|null, lastSyncHeight: number|null, isBackgroundSyncRunning: boolean, hasSyncedThisSession: boolean, progress: object}}
 */
export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime,
    lastSyncHeight,
    isBackgroundSyncRunning: backgroundSyncInterval !== null,
    hasSyncedThisSession,
    progress: { ...currentSyncProgress }
  }
}

/**
 * Get transaction history
 * Returns cached history immediately if available, merged with fresh data after sync
 * @param {number} limit - Maximum number of transactions
 * @returns {Promise<Array>}
 */
export async function getTransactions(limit = Infinity) {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()

  // If we haven't synced yet this session but have cached data, return it immediately
  // This provides instant UI display while delta sync is in progress
  // Note: Confirmations may be stale until sync completes and updates the chain height
  if (!hasSyncedThisSession && cachedTxHistory && cachedTxHistory.length > 0) {
    console.log('[Wallet] Returning cached transaction history (pre-sync):', cachedTxHistory.length, 'transactions')
    // If we have a lastSyncHeight from previous session, use it to recalculate confirmations
    const walletMeta = walletStorage.getWalletMeta(DATA_DIR, currentAccountName)
    const cachedHeight = walletMeta?.lastSyncedHeight
    if (cachedHeight) {
      return cachedTxHistory.slice(0, limit).map(tx => ({
        ...tx,
        confirmations: tx.height ? Math.max(0, cachedHeight - tx.height + 1) : 0
      }))
    }
    return cachedTxHistory.slice(0, limit)
  }

  await ensureFullWallet()

  let txs = []
  try {
    txs = await currentWallet.getTxs()
  } catch (e) {
    console.warn('[Wallet] Error getting transactions:', e.message)
    // If we have cached history, return it as fallback with recalculated confirmations
    if (cachedTxHistory && cachedTxHistory.length > 0) {
      console.log('[Wallet] Returning cached history as fallback')
      const currentHeight = lastSyncHeight || 0
      if (currentHeight > 0) {
        return cachedTxHistory.slice(0, limit).map(tx => ({
          ...tx,
          confirmations: tx.height ? Math.max(0, currentHeight - tx.height + 1) : 0
        }))
      }
      return cachedTxHistory.slice(0, limit)
    }
    return []
  }

  if (!txs || txs.length === 0) {
    // If wallet returns no transactions but we have cached history, use it
    // This handles the delta sync case where new blocks have no transactions
    if (cachedTxHistory && cachedTxHistory.length > 0) {
      console.log('[Wallet] No new transactions, returning cached history with recalculated confirmations')
      // Recalculate confirmations based on current chain height
      const currentHeight = lastSyncHeight || await currentWallet.getHeight()
      return cachedTxHistory.slice(0, limit).map(tx => ({
        ...tx,
        confirmations: tx.height ? Math.max(0, currentHeight - tx.height + 1) : 0
      }))
    }
    return []
  }

  // Process transactions from wallet
  // Key insight: A transaction can have BOTH incoming (change) AND outgoing components
  // When sending XMR, change comes back as an incoming transfer in the SAME transaction
  // We classify such transactions as OUTGOING with the NET amount sent
  const processed = txs.map(tx => {
    const getValue = (obj, methodName, propName) => {
      if (typeof obj[methodName] === 'function') return obj[methodName]()
      if (propName && obj[propName] !== undefined) return obj[propName]
      return undefined
    }

    const txid = getValue(tx, 'getHash', 'hash')
    const height = getValue(tx, 'getHeight', 'height')
    const timestamp = getValue(tx, 'getTimestamp', 'timestamp')
    const fee = getValue(tx, 'getFee', 'fee')
    const confirmations = getValue(tx, 'getNumConfirmations', 'numConfirmations') || 0

    const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers')
    const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer')
    const hasIncoming = incomingTransfers && incomingTransfers.length > 0
    const hasOutgoing = outgoingTransfer !== undefined && outgoingTransfer !== null

    // Classification logic:
    // - If transaction has outgoing transfer, classify as OUTGOING (even if it also has change)
    // - Only classify as INCOMING if it has NO outgoing transfer (pure receive)
    const isOutgoing = hasOutgoing
    const isIncoming = hasIncoming && !hasOutgoing

    let amount = 0n
    let subaddressIndices = []

    if (isOutgoing) {
      // For outgoing transactions, use outgoingAmount which is the NET amount sent
      // (excludes change that comes back to us)
      const outAmount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount')
      amount = outAmount ? BigInt(outAmount.toString()) : 0n
    } else if (isIncoming) {
      // For pure incoming transactions (no outgoing component), use incomingAmount
      const inAmount = getValue(tx, 'getIncomingAmount', 'incomingAmount')
      amount = inAmount ? BigInt(inAmount.toString()) : 0n

      // Extract subaddress indices for incoming transactions (for post linking)
      if (incomingTransfers && incomingTransfers.length > 0) {
        const subaddrSet = new Set()
        for (const transfer of incomingTransfers) {
          const getTransferValue = (obj, method, prop) => {
            if (typeof obj[method] === 'function') return obj[method]()
            if (prop && obj[prop] !== undefined) return obj[prop]
            return undefined
          }
          const subaddrIndex = getTransferValue(transfer, 'getSubaddressIndex', 'subaddressIndex')
          if (subaddrIndex !== undefined && subaddrIndex !== null) {
            subaddrSet.add(subaddrIndex)
          }
        }
        subaddressIndices = Array.from(subaddrSet)
      }
    }

    return {
      txid,
      height,
      timestamp,
      isIncoming,
      isOutgoing,
      amount,
      fee: fee ? BigInt(fee.toString()) : 0n,
      confirmations,
      subaddressIndices
    }
  })

  // Merge with cached history if available (handles delta sync case)
  let merged = processed
  if (cachedTxHistory && cachedTxHistory.length > 0) {
    merged = mergeTransactionHistory(cachedTxHistory, processed)
    console.log('[Wallet] Merged transactions: cached=', cachedTxHistory.length, 'new=', processed.length, 'merged=', merged.length)
  }

  // Get current chain height for recalculating confirmations on cached transactions
  const currentHeight = lastSyncHeight || await currentWallet.getHeight()

  // Sort by timestamp (newest first), recalculate confirmations, and limit
  return merged
    .sort((a, b) => {
      const aTime = a.timestamp || (a.height ? a.height * 120 : 0)
      const bTime = b.timestamp || (b.height ? b.height * 120 : 0)
      return bTime - aTime
    })
    .slice(0, limit)
    .map(tx => ({
      ...tx,
      // Recalculate confirmations based on current chain height
      // This ensures cached transactions have up-to-date confirmation counts
      confirmations: tx.height ? Math.max(0, currentHeight - tx.height + 1) : 0
    }))
}

/**
 * Get the decrypted seed phrase (requires unlock)
 * @returns {string}
 */
export function getSeed() {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  resetUnlockTimeout()
  return decryptedSeed
}

/**
 * Delete wallet for an account
 * @param {string} accountName - Account name
 * @param {string} password - Password to verify
 * @returns {Promise<void>}
 */
export async function deleteWallet(accountName, password) {
  if (!accountName || typeof accountName !== 'string') {
    throw new Error('Account name is required')
  }

  // Check if wallet exists
  if (!(await hasWallet(accountName))) {
    throw new Error('No wallet found for this account')
  }

  // Verify password by attempting to load
  await walletStorage.loadWallet(DATA_DIR, accountName, password)

  // Lock if this is the current wallet
  if (currentAccountName === accountName) {
    await lock()
  }

  // Delete wallet files (including binary wallet data)
  walletStorage.deleteWallet(DATA_DIR, accountName)
  walletStorage.deleteWalletBinaryData(DATA_DIR, accountName)
}

/**
 * Format atomic units to XMR string
 * @param {bigint} atomicUnits - Amount in atomic units
 * @returns {string} Formatted XMR amount
 */
export function formatXMR(atomicUnits) {
  if (typeof atomicUnits !== 'bigint') {
    atomicUnits = BigInt(atomicUnits || 0)
  }

  const isNegative = atomicUnits < 0n
  const absUnits = isNegative ? -atomicUnits : atomicUnits

  const str = absUnits.toString().padStart(13, '0')
  const intPart = str.slice(0, -12) || '0'
  const decPart = str.slice(-12)

  // Trim trailing zeros but keep at least one decimal
  let trimmed = decPart.replace(/0+$/, '') || '0'

  const result = `${intPart}.${trimmed.padEnd(1, '0')}`
  return isNegative ? `-${result}` : result
}

/**
 * Parse XMR string to atomic units
 * @param {string} xmr - XMR amount as string
 * @returns {bigint} Amount in atomic units
 */
export function parseXMR(xmr) {
  if (typeof xmr !== 'string') {
    throw new Error('XMR amount must be a string')
  }

  const trimmed = xmr.trim()
  if (trimmed === '') {
    throw new Error('XMR amount cannot be empty')
  }

  // Handle negative values
  const isNegative = trimmed.startsWith('-')
  const absValue = isNegative ? trimmed.slice(1) : trimmed

  // Split into integer and decimal parts
  const parts = absValue.split('.')
  if (parts.length > 2) {
    throw new Error('Invalid XMR format')
  }

  const intPart = parts[0] || '0'
  let decPart = parts[1] || '0'

  // Validate parts are numeric
  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(decPart)) {
    throw new Error('Invalid XMR format')
  }

  // Pad or truncate decimal to 12 places
  decPart = decPart.padEnd(12, '0').slice(0, 12)

  // Combine and convert to bigint
  const atomicStr = intPart + decPart
  const result = BigInt(atomicStr)

  return isNegative ? -result : result
}

/**
 * Ensure we have a full wallet instance for operations
 */
async function ensureFullWallet() {
  if (currentWallet) {
    return currentWallet
  }

  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }

  // Find a working node
  const serverUri = await findWorkingNode()

  // Check if we have persisted binary wallet data (contains outputs and key images)
  // Loading from binary data enables proper delta sync
  if (currentWalletPassword && walletStorage.hasWalletBinaryData(DATA_DIR, currentAccountName)) {
    try {
      console.log('[Wallet] Loading wallet from binary data for delta sync...')
      const { keysData, cacheData } = await walletStorage.loadWalletBinaryData(
        DATA_DIR,
        currentAccountName,
        currentWalletPassword
      )

      // Open wallet from binary data (preserves outputs and key images)
      currentWallet = await moneroTs.openWalletFull({
        networkType: moneroTs.MoneroNetworkType.MAINNET,
        keysData: keysData,
        cacheData: cacheData,
        server: serverUri,
        proxyToWorker: true
      })

      // Verify connection
      try {
        await currentWallet.getDaemonHeight()
      } catch (e) {
        console.warn('[Wallet] Initial connection check failed:', e.message)
        await currentWallet.setDaemonConnection(serverUri)
      }

      console.log('[Wallet] Opened wallet from binary data successfully')
      return currentWallet
    } catch (e) {
      console.warn('[Wallet] Failed to load from binary data, falling back to seed:', e.message)
      // Fall through to create from seed
    }
  }

  // Fallback: Create wallet from seed
  // Get restore height from wallet metadata
  // Use the greater of restoreHeight and lastSyncedHeight for delta sync
  // This avoids re-scanning blocks we've already processed
  // Cached balance + txHistory are loaded on unlock and displayed immediately
  const walletMeta = walletStorage.getWalletMeta(DATA_DIR, currentAccountName)
  const restoreHeight = walletMeta?.restoreHeight || 0
  const lastSyncedHeight = walletMeta?.lastSyncedHeight || 0
  const effectiveRestoreHeight = Math.max(restoreHeight, lastSyncedHeight)

  // Create wallet from seed
  console.log('[Wallet] Creating wallet from seed, restore height:', effectiveRestoreHeight, '(original:', restoreHeight, ', lastSynced:', lastSyncedHeight, ')')

  currentWallet = await moneroTs.createWalletFull({
    networkType: moneroTs.MoneroNetworkType.MAINNET,
    seed: decryptedSeed,
    restoreHeight: effectiveRestoreHeight,
    server: serverUri,
    proxyToWorker: true
  })

  // Verify connection
  try {
    await currentWallet.getDaemonHeight()
  } catch (e) {
    console.warn('[Wallet] Initial connection check failed:', e.message)
    await currentWallet.setDaemonConnection(serverUri)
  }

  return currentWallet
}

/**
 * Get the currently selected node information
 * @returns {{url: string, latency: number}|null}
 */
export function getSelectedNode() {
  return nodeSelector.getSelectedNode()
}

/**
 * Get detailed transaction information including TX key
 * @param {string} txid - Transaction hash/ID
 * @returns {Promise<{tx: object, txKey: string|null}>}
 */
export async function getTransactionDetails(txid) {
  if (!isWalletUnlocked()) {
    throw new Error('Wallet is locked')
  }
  if (!txid || typeof txid !== 'string') {
    throw new Error('Transaction ID is required')
  }
  resetUnlockTimeout()

  await ensureFullWallet()

  // Get the transaction with full transfer details
  let tx = null
  try {
    const txQuery = new moneroTs.MoneroTxQuery()
      .setHash(txid)
      .setIncludeOutputs(true)
    const txs = await currentWallet.getTxs(txQuery)
    if (txs && txs.length > 0) {
      tx = txs[0]
    }
  } catch (e) {
    console.warn('[Wallet] Error getting transaction:', e.message)
  }

  // Get the TX key (proof of payment) - do this before checking cache so we have it
  let txKey = null
  try {
    txKey = await currentWallet.getTxKey(txid)
  } catch (e) {
    console.warn('[Wallet] Could not get TX key:', e.message)
    // TX key may not be available for incoming transactions
  }

  // If direct query failed or returned no useful data, try to find in cached transaction history
  if (!tx && cachedTxHistory && cachedTxHistory.length > 0) {
    const cachedTx = cachedTxHistory.find(t => t.txid === txid)
    if (cachedTx) {
      console.log('[Wallet] Using cached transaction data for:', txid)
      // Return the cached data directly since we have all the fields we need
      const currentHeight = lastSyncHeight || await currentWallet.getHeight()
      // Handle older cached data that might not have isIncoming/isOutgoing
      const isIncoming = cachedTx.isIncoming !== undefined ? cachedTx.isIncoming : (cachedTx.amount > 0n)
      const isOutgoing = cachedTx.isOutgoing !== undefined ? cachedTx.isOutgoing : (cachedTx.amount < 0n || cachedTx.fee > 0n)
      return {
        txid,
        txKey,
        amount: cachedTx.amount,
        fee: cachedTx.fee,
        isIncoming,
        isOutgoing,
        confirmations: cachedTx.height ? Math.max(0, currentHeight - cachedTx.height + 1) : cachedTx.confirmations || 0,
        height: cachedTx.height,
        timestamp: cachedTx.timestamp,
        address: null,
        subaddressIndices: cachedTx.subaddressIndices || []  // Include cached subaddress indices if available
      }
    }
  }

  // Extract transaction details
  let details = {
    txid,
    txKey,
    amount: 0n,
    fee: 0n,
    isIncoming: false,
    isOutgoing: false,
    confirmations: 0,
    height: null,
    timestamp: null,
    address: null,
    subaddressIndices: []  // For incoming transactions, tracks which subaddresses received funds
  }

  if (tx) {
    const getValue = (obj, methodName, propName) => {
      if (typeof obj[methodName] === 'function') return obj[methodName]()
      if (propName && obj[propName] !== undefined) return obj[propName]
      return undefined
    }

    details.height = getValue(tx, 'getHeight', 'height')
    details.timestamp = getValue(tx, 'getTimestamp', 'timestamp')

    // Calculate confirmations based on current chain height
    // This ensures up-to-date confirmation count even if the tx query returns stale data
    const currentHeight = lastSyncHeight || await currentWallet.getHeight()
    details.confirmations = details.height ? Math.max(0, currentHeight - details.height + 1) : 0

    const fee = getValue(tx, 'getFee', 'fee')
    details.fee = fee ? BigInt(fee.toString()) : 0n

    const incomingTransfers = getValue(tx, 'getIncomingTransfers', 'incomingTransfers')
    const outgoingTransfer = getValue(tx, 'getOutgoingTransfer', 'outgoingTransfer')
    const hasIncoming = !!(incomingTransfers && incomingTransfers.length > 0)
    const hasOutgoing = outgoingTransfer !== undefined && outgoingTransfer !== null

    // Classification logic:
    // - If transaction has outgoing transfer, classify as OUTGOING (even if it also has change)
    // - Only classify as INCOMING if it has NO outgoing transfer (pure receive)
    details.isOutgoing = hasOutgoing
    details.isIncoming = hasIncoming && !hasOutgoing

    if (details.isOutgoing) {
      // For outgoing transactions, use outgoingAmount which is the NET amount sent
      const outAmount = getValue(tx, 'getOutgoingAmount', 'outgoingAmount')
      details.amount = outAmount ? BigInt(outAmount.toString()) : 0n

      // For outgoing, get the destination addresses
      if (outgoingTransfer) {
        const getTransferValue = (obj, method, prop) => {
          if (typeof obj[method] === 'function') return obj[method]()
          if (prop && obj[prop] !== undefined) return obj[prop]
          return undefined
        }

        const destinations = getTransferValue(outgoingTransfer, 'getDestinations', 'destinations')
        if (destinations && destinations.length > 0) {
          // Get address from first destination
          const firstDest = destinations[0]
          details.address = getTransferValue(firstDest, 'getAddress', 'address')
        }
      }
    } else if (details.isIncoming) {
      // For pure incoming transactions (no outgoing component), use incomingAmount
      const inAmount = getValue(tx, 'getIncomingAmount', 'incomingAmount')
      details.amount = inAmount ? BigInt(inAmount.toString()) : 0n

      // For incoming, try to get the receiving address and subaddress indices
      if (incomingTransfers && incomingTransfers.length > 0) {
        const getTransferValue = (obj, method, prop) => {
          if (typeof obj[method] === 'function') return obj[method]()
          if (prop && obj[prop] !== undefined) return obj[prop]
          return undefined
        }

        // Get address from first transfer
        const firstTransfer = incomingTransfers[0]
        details.address = getTransferValue(firstTransfer, 'getAddress', 'address')

        // Collect all subaddress indices from incoming transfers
        const subaddrSet = new Set()
        for (const transfer of incomingTransfers) {
          const subaddrIndex = getTransferValue(transfer, 'getSubaddressIndex', 'subaddressIndex')
          if (subaddrIndex !== undefined && subaddrIndex !== null) {
            subaddrSet.add(subaddrIndex)
          }
        }
        details.subaddressIndices = Array.from(subaddrSet)
      }
    }

    // If we got a tx but amount is still 0, try to supplement from cached data
    // This handles cases where the tx query returned partial data
    if (details.amount === 0n && cachedTxHistory && cachedTxHistory.length > 0) {
      const cachedTx = cachedTxHistory.find(t => t.txid === txid)
      if (cachedTx && cachedTx.amount) {
        console.log('[Wallet] Supplementing tx details with cached amount data')
        details.amount = cachedTx.amount
        details.fee = cachedTx.fee || details.fee
        // Use cached classification if we didn't detect it from the tx object
        if (!details.isIncoming && !details.isOutgoing) {
          // Only use cached values if they're actually defined
          if (cachedTx.isIncoming !== undefined) {
            details.isIncoming = cachedTx.isIncoming
          }
          if (cachedTx.isOutgoing !== undefined) {
            details.isOutgoing = cachedTx.isOutgoing
          }
          // Fallback: infer from amount if still not set
          if (!details.isIncoming && !details.isOutgoing && cachedTx.amount) {
            details.isIncoming = cachedTx.amount > 0n
            details.isOutgoing = cachedTx.amount < 0n || (cachedTx.fee && cachedTx.fee > 0n)
          }
        }
        // Copy subaddress indices from cache if available and we don't have them
        if ((!details.subaddressIndices || details.subaddressIndices.length === 0) && cachedTx.subaddressIndices) {
          details.subaddressIndices = cachedTx.subaddressIndices
        }
      }
    }
  }

  // For outgoing transactions, check if this was a tip we sent
  if (details.isOutgoing && outgoingTipPosts.has(txid)) {
    details.tippedPost = outgoingTipPosts.get(txid)
  }

  return details
}

/**
 * Verify a transaction was sent to a specific address using tx key
 * Used for verifying supporter listing payments
 * @param {string} txHash - Transaction hash
 * @param {string} address - Destination address to verify
 * @param {string} txKey - Transaction private key
 * @returns {Promise<{verified: boolean, amount?: bigint, confirmations?: number, reason?: string}>}
 */
export async function checkTxKey(txHash, address, txKey) {
  if (!isUnlocked || !currentWallet) {
    return { verified: false, reason: 'wallet_locked' }
  }

  try {
    // monero-ts signature is (txHash, txKey, address) — distinct from our
    // wrapper's (txHash, address, txKey). Swap here, do not swap the wrapper
    // signature (too many call sites).
    const check = await currentWallet.checkTxKey(txHash, txKey, address)

    if (check) {
      // monero-ts checkTxKey returns an object with received amount and confirmations
      const received = check.getReceivedAmount ? check.getReceivedAmount() : (check.receivedAmount || 0n)
      const confirmations = check.getNumConfirmations ? check.getNumConfirmations() : (check.numConfirmations || 0)
      const isConfirmed = check.getIsConfirmed ? check.getIsConfirmed() : (check.isConfirmed !== false)

      if (received > 0n) {
        return {
          verified: true,
          amount: BigInt(received.toString()),
          confirmations,
          isConfirmed
        }
      }
    }

    return { verified: false, reason: 'no_payment_found' }
  } catch (err) {
    console.error('[Wallet] checkTxKey error:', err.message)
    return { verified: false, reason: err.message }
  }
}

/**
 * Save a mapping from transaction hash to the post that was tipped
 * Called after successfully sending a tip
 * @param {string} txHash - Transaction hash
 * @param {string} pubkey - Post author's pubkey
 * @param {number} timestamp - Post timestamp
 */
export function saveTipPostMapping(txHash, pubkey, timestamp) {
  outgoingTipPosts.set(txHash, { pubkey, timestamp })
  // Also persist to storage
  if (DATA_DIR && currentAccountName) {
    try {
      const tipMappings = {}
      for (const [hash, post] of outgoingTipPosts.entries()) {
        tipMappings[hash] = post
      }
      walletStorage.saveTipMappings(DATA_DIR, currentAccountName, tipMappings)
    } catch (e) {
      console.warn('[Wallet] Error saving tip mappings:', e.message)
    }
  }
}

/**
 * Load tip mappings from storage
 * Called on wallet unlock
 */
function loadTipMappings() {
  if (!DATA_DIR || !currentAccountName) return
  try {
    const tipMappings = walletStorage.loadTipMappings(DATA_DIR, currentAccountName)
    if (tipMappings) {
      outgoingTipPosts = new Map(Object.entries(tipMappings))
    }
  } catch (e) {
    console.warn('[Wallet] Error loading tip mappings:', e.message)
  }
}

// Track announced tip txids to avoid duplicate announcements
let announcedTipTxids = new Set()

/**
 * Get incoming transactions that can be linked to posts via subaddress_index
 * These are potential tips that the author should announce
 * @param {Map} subaddressToPost - Mapping of subaddress_index -> { pubkey, timestamp }
 * @returns {Array<{txid: string, amount: bigint, subaddressIndex: number, postTimestamp: number, txProof: string|null}>}
 */
export async function getIncomingTipsForPosts(subaddressToPost) {
  if (!isWalletUnlocked() || !subaddressToPost || subaddressToPost.size === 0) {
    return []
  }

  const tips = []

  // Use cached transaction history if available
  const txHistory = cachedTxHistory || []

  for (const tx of txHistory) {
    // Skip if not incoming or already announced
    if (!tx.isIncoming || announcedTipTxids.has(tx.txid)) {
      continue
    }

    // Check if any subaddress index matches our post mapping
    if (tx.subaddressIndices && tx.subaddressIndices.length > 0) {
      for (const subaddrIndex of tx.subaddressIndices) {
        const postInfo = subaddressToPost.get(subaddrIndex)
        if (postInfo) {
          // Get tx key for proof if available
          let txProof = null
          try {
            if (currentWallet) {
              const txKey = await currentWallet.getTxKey(tx.txid)
              txProof = txKey ? `${tx.txid}:${txKey}` : tx.txid
            }
          } catch (e) {
            // TX key not available for received transactions usually
            txProof = tx.txid
          }

          tips.push({
            txid: tx.txid,
            amount: tx.amount,
            subaddressIndex: subaddrIndex,
            postTimestamp: postInfo.timestamp,
            txProof
          })
          break // Only add once per transaction
        }
      }
    }
  }

  return tips
}

/**
 * Get ALL new incoming transactions (not yet announced)
 * Used to detect tips when no post-specific subaddress mapping exists
 * @returns {Array<{txid: string, amount: bigint, txProof: string|null}>}
 */
export async function getAllIncomingTips() {
  if (!isWalletUnlocked()) {
    return []
  }

  const tips = []
  const txHistory = cachedTxHistory || []

  for (const tx of txHistory) {
    // Skip if not incoming or already announced
    if (!tx.isIncoming || announcedTipTxids.has(tx.txid)) {
      continue
    }

    // Get tx key for proof if available
    let txProof = null
    try {
      if (currentWallet) {
        const txKey = await currentWallet.getTxKey(tx.txid)
        txProof = txKey ? `${tx.txid}:${txKey}` : tx.txid
      }
    } catch (e) {
      txProof = tx.txid
    }

    tips.push({
      txid: tx.txid,
      amount: tx.amount,
      postTimestamp: null, // Not linked to a specific post
      txProof
    })
  }

  return tips
}

/**
 * Mark a tip transaction as announced (to avoid re-announcing on next sync)
 * @param {string} txid - Transaction ID
 */
export function markTipAnnounced(txid) {
  announcedTipTxids.add(txid)
  // Persist to storage for persistence across sessions
  if (DATA_DIR && currentAccountName) {
    try {
      const announced = Array.from(announcedTipTxids)
      walletStorage.saveAnnouncedTips(DATA_DIR, currentAccountName, announced)
    } catch (e) {
      console.warn('[Wallet] Error saving announced tips:', e.message)
    }
  }
}

/**
 * Load announced tips from storage
 * Called on wallet unlock
 */
function loadAnnouncedTips() {
  if (!DATA_DIR || !currentAccountName) return
  try {
    const announced = walletStorage.loadAnnouncedTips(DATA_DIR, currentAccountName)
    if (announced && Array.isArray(announced)) {
      announcedTipTxids = new Set(announced)
      console.log('[Wallet] Loaded', announcedTipTxids.size, 'announced tips')
    }
  } catch (e) {
    console.warn('[Wallet] Error loading announced tips:', e.message)
  }
}
