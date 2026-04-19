/**
 * Feed Backup Flow — free toggle for active supporters.
 *
 * Backup sync is included in the supporter subscription ($12/yr paid via
 * the supporter listing flow). Enabling backup just tells the server to
 * start replicating this account's feed. No separate payment is made.
 */

import { state } from '../state.js'
import { getSupporterManager } from '../../lib/supporter-manager.js'

async function waitForConnection(client, timeoutMs = 15000) {
  if (client.isConnected) return
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (client.isConnected) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Could not connect to sync server. Try again later.')
}

/**
 * Activate feed backup for the current account.
 *
 * @param {Object} opts
 * @param {Function} opts.onStatus - Called with human-readable status strings
 * @returns {Promise<{ok: boolean, status?: Object}>}
 */
export async function runFeedBackupPurchase({ onStatus }) {
  const client = state.syncClient
  if (!client) {
    throw new Error('Sync client not initialized. Restart the app.')
  }

  const pubkey = state.identity?.pubkeyHex
  if (!pubkey) throw new Error('No identity available')

  const supporterManager = getSupporterManager()
  if (!supporterManager.isListed(pubkey)) {
    if (supporterManager.isExpired(pubkey)) {
      throw new Error('Your supporter subscription has expired. Please renew to re-enable backup.')
    }
    throw new Error('Become a supporter first to enable feed backup.')
  }

  const listing = supporterManager.getListing(pubkey)
  const txProof = listing?.listing?.tx_proof
  if (!txProof || typeof txProof !== 'string' || !txProof.includes(':')) {
    throw new Error('Could not find supporter payment proof. Contact support.')
  }
  const [txHash, txKey] = txProof.split(':')

  onStatus?.('Contacting sync server…')
  if (!client.isConnected) {
    try { await client.init() } catch (e) { /* retry via waitForConnection */ }
  }
  await waitForConnection(client)

  onStatus?.('Activating backup…')
  const status = await client.enableBackup(txHash, txKey)

  localStorage.setItem('swarmnero_sync_active', 'true')
  localStorage.setItem('swarmnero_sync_expires', status.expiresAt?.toString() || '')

  return { ok: true, status }
}

/**
 * Disable feed backup via the sync server. The server stops replicating the
 * user's feed but keeps the subscription record so re-enable is free for the
 * rest of the period.
 */
export async function runFeedBackupDisable({ onStatus } = {}) {
  const client = state.syncClient
  if (!client) throw new Error('Sync client not initialized.')

  onStatus?.('Disabling backup…')
  if (!client.isConnected) {
    try { await client.init() } catch (e) { /* retry via waitForConnection */ }
  }
  await waitForConnection(client)

  const status = await client.disableBackup()

  localStorage.setItem('swarmnero_sync_active', 'false')
  localStorage.removeItem('swarmnero_sync_expires')

  return { ok: true, status }
}
