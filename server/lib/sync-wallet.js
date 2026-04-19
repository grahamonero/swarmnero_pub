/**
 * Sync Wallet - Server-side Monero wallet via monero-wallet-rpc
 * Uses HTTP JSON-RPC to communicate with the local monero-wallet-rpc process
 */

import http from 'http'

const RPC_URL = 'http://127.0.0.1:18083/json_rpc'

function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: '0',
      method,
      params
    })

    const url = new URL(RPC_URL)
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) {
            reject(new Error(json.error.message))
          } else {
            resolve(json.result)
          }
        } catch (err) {
          reject(new Error('Invalid JSON response'))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('RPC request timeout'))
    })
    req.write(body)
    req.end()
  })
}

export class SyncWallet {
  constructor() {
    this.ready = false
  }

  /**
   * Check if wallet RPC is available
   */
  async init() {
    try {
      const result = await rpcCall('get_address')
      console.log(`[SyncWallet] Connected to wallet RPC`)
      console.log(`[SyncWallet] Address: ${result.address.slice(0, 16)}...`)
      this.ready = true
      return this
    } catch (err) {
      console.error('[SyncWallet] Cannot connect to monero-wallet-rpc:', err.message)
      throw err
    }
  }

  /**
   * Refresh wallet to detect new transactions
   */
  async sync() {
    if (!this.ready) return
    try {
      await rpcCall('refresh')
      const height = await rpcCall('get_height')
      console.log(`[SyncWallet] Refreshed, height: ${height.height}`)
    } catch (err) {
      console.error('[SyncWallet] Refresh error:', err.message)
    }
  }

  /**
   * Create a new subaddress and return it
   * @param {number} accountIndex - Account index (0 for default)
   * @returns {{ address: string, addressIndex: number }}
   */
  async createSubaddress(accountIndex = 0) {
    const result = await rpcCall('create_address', {
      account_index: accountIndex,
      label: `supporter-${Date.now()}`
    })
    return {
      address: result.address,
      addressIndex: result.address_index
    }
  }

  /**
   * Get or create a subaddress at a specific index
   * @param {number} index - Subaddress index
   * @returns {string} Monero subaddress
   */
  async getSubaddress(index) {
    // First try to get existing subaddress
    try {
      const result = await rpcCall('get_address', {
        account_index: 0,
        address_index: [index]
      })
      if (result.addresses && result.addresses.length > 0) {
        return result.addresses[0].address
      }
    } catch (err) {
      // Index doesn't exist yet — create subaddresses up to this index
      console.log(`[SyncWallet] Subaddress ${index} not found, creating...`)
    }

    // Create subaddresses up to the needed index
    const existing = await rpcCall('get_address', { account_index: 0 })
    const currentCount = existing.addresses ? existing.addresses.length : 1

    let lastAddress = null
    for (let i = currentCount; i <= index; i++) {
      const sub = await this.createSubaddress(0)
      lastAddress = sub.address
    }

    return lastAddress
  }

  /**
   * Check for incoming payments to tracked subaddresses
   * @param {Object} syncManager - SyncManager instance
   * @returns {Array} Detected payments
   */
  async checkPayments(syncManager) {
    if (!this.ready) return []

    try {
      await rpcCall('refresh')
      const result = await rpcCall('get_transfers', {
        in: true,
        pending: true,
        pool: true,
        account_index: 0
      })

      const payments = []
      const incoming = [...(result.in || []), ...(result.pending || []), ...(result.pool || [])]

      for (const tx of incoming) {
        const subaddressIndex = tx.subaddr_index?.minor
        if (subaddressIndex == null || subaddressIndex === 0) continue

        const pubkey = syncManager.getAccountBySubaddressIndex(subaddressIndex)
        if (!pubkey) continue

        const account = syncManager.getAccount(pubkey)
        if (account && !account.active) {
          payments.push({
            pubkey,
            amount: tx.amount?.toString() || '0',
            txHash: tx.txid,
            subaddressIndex
          })
        }
      }

      return payments
    } catch (err) {
      console.error('[SyncWallet] Error checking payments:', err.message)
      return []
    }
  }

  /**
   * Verify a payment using tx key
   * @param {string} txHash - Transaction hash
   * @param {string} txKey - Transaction key
   * @param {string} address - Expected destination address
   * @returns {{ verified: boolean, amount: string|null }}
   */
  async verifyPayment(txHash, txKey, address) {
    if (!this.ready) return { verified: false, amount: null }

    try {
      const result = await rpcCall('check_tx_key', {
        txid: txHash,
        tx_key: txKey,
        address
      })

      if (result && result.received > 0) {
        return {
          verified: true,
          amount: result.received.toString()
        }
      }
      return { verified: false, amount: null }
    } catch (err) {
      console.error('[SyncWallet] Payment verification error:', err.message)
      return { verified: false, amount: null }
    }
  }

  /**
   * Get primary wallet address
   */
  async getAddress() {
    const result = await rpcCall('get_address')
    return result.address
  }

  /**
   * Close (no-op for RPC, the systemd service manages the process)
   */
  async close() {
    this.ready = false
    console.log('[SyncWallet] Closed')
  }
}
