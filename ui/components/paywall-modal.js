/**
 * Paywall unlock modal — confirmation flow for buying a paywalled post
 */

import { state } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { isAuthorOnline } from '../utils/format.js'
import * as wallet from '../../lib/wallet.js'
import { createUnlockRequestEvent } from '../../lib/events.js'

const ATOMIC_PER_XMR = 1_000_000_000_000n

function xmrToAtomic(xmrStr) {
  const [whole, frac = ''] = String(xmrStr).split('.')
  const fracPadded = (frac + '000000000000').slice(0, 12)
  return BigInt(whole) * ATOMIC_PER_XMR + BigInt(fracPadded)
}

function atomicToXmr(atomic) {
  const big = BigInt(atomic.toString())
  const whole = big / ATOMIC_PER_XMR
  const frac = big % ATOMIC_PER_XMR
  const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

/**
 * Show the paywall unlock confirmation modal
 * @param {Object} post - The paywalled post event
 */
export function showPaywallUnlockModal(post) {
  if (!post || !post.paywall_price || !post.paywall_subaddress) {
    alert('This post is missing paywall details and cannot be unlocked.')
    return
  }

  // Remove any existing modal
  const existing = document.getElementById('paywallModal')
  if (existing) existing.remove()

  const onlineStatus = isAuthorOnline(post.pubkey)
  const onlineHint = onlineStatus === 'online'
    ? '<div class="paywall-online-hint paywall-online">⚡ Author is online — instant unlock expected</div>'
    : onlineStatus === 'offline'
      ? '<div class="paywall-online-hint paywall-offline">⏳ Author is offline — unlock will complete when they come back online</div>'
      : ''

  const modal = document.createElement('div')
  modal.id = 'paywallModal'
  modal.className = 'modal-overlay'
  modal.innerHTML = `
    <div class="modal paywall-modal">
      <div class="modal-header">
        <h3>🔒 Unlock Post</h3>
        <button class="modal-close" id="paywallModalClose">&times;</button>
      </div>
      <div class="modal-body">
        <div class="paywall-modal-preview">
          <p class="paywall-preview-label">Preview:</p>
          <p class="paywall-preview-text">${escapeHtml(post.paywall_preview || '(no preview)')}</p>
        </div>
        ${onlineHint}
        <div class="paywall-modal-price">
          <span class="paywall-modal-price-label">Price:</span>
          <span class="paywall-modal-price-value">${escapeHtml(post.paywall_price)} XMR</span>
        </div>
        <div class="paywall-warning">
          ⚠️ <strong>You are paying directly to the author.</strong> If they go offline permanently before delivering the decryption key, no refund is possible. Only unlock posts from authors you trust.
        </div>
        <div id="paywallModalStatus" class="paywall-modal-status"></div>
      </div>
      <div class="modal-footer">
        <button id="paywallModalCancel" class="btn-secondary">Cancel</button>
        <button id="paywallModalConfirm" class="btn-primary">Pay & Unlock</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const closeBtn = document.getElementById('paywallModalClose')
  const cancelBtn = document.getElementById('paywallModalCancel')
  const confirmBtn = document.getElementById('paywallModalConfirm')
  const statusEl = document.getElementById('paywallModalStatus')

  function close() {
    modal.remove()
  }

  closeBtn.addEventListener('click', close)
  cancelBtn.addEventListener('click', close)
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close()
  })

  confirmBtn.addEventListener('click', async () => {
    if (!wallet.isWalletUnlocked()) {
      statusEl.textContent = 'Your wallet is locked. Unlock it first.'
      statusEl.className = 'paywall-modal-status error'
      return
    }

    confirmBtn.disabled = true
    cancelBtn.disabled = true
    statusEl.textContent = 'Creating transaction...'
    statusEl.className = 'paywall-modal-status'

    try {
      // Create transaction
      const amount = xmrToAtomic(post.paywall_price)
      let txInfo
      try {
        txInfo = await wallet.createTransaction(post.paywall_subaddress, amount)
      } catch (err) {
        statusEl.textContent = 'Could not create transaction: ' + err.message
        statusEl.className = 'paywall-modal-status error'
        confirmBtn.disabled = false
        cancelBtn.disabled = false
        return
      }

      const fee = atomicToXmr(txInfo.fee)
      const total = atomicToXmr(amount + BigInt(txInfo.fee.toString()))

      // Confirmation step
      const confirmed = confirm(
        `Confirm payment:\n\n` +
        `Amount: ${post.paywall_price} XMR\n` +
        `Network fee: ${fee} XMR\n` +
        `Total: ${total} XMR\n\n` +
        `Click OK to broadcast the transaction.`
      )

      if (!confirmed) {
        // Cancel pending transaction
        statusEl.textContent = 'Cancelled.'
        confirmBtn.disabled = false
        cancelBtn.disabled = false
        return
      }

      statusEl.textContent = 'Broadcasting transaction...'

      // Relay
      const relayResult = await wallet.relayTransaction()
      const { txHash, txKey } = relayResult

      statusEl.textContent = 'Payment sent. Announcing unlock request...'

      // Append unlock_request event to our own feed
      const event = createUnlockRequestEvent({
        postPubkey: post.pubkey,
        postTimestamp: post.timestamp,
        txHash,
        txKey,
        buyerPubkey: state.identity.pubkeyHex
      })
      await state.feed.append(event)

      statusEl.textContent = 'Done! The post will unlock automatically once the author processes your payment. You can close this window.'
      statusEl.className = 'paywall-modal-status success'
      confirmBtn.style.display = 'none'
      cancelBtn.textContent = 'Close'
      cancelBtn.disabled = false
    } catch (err) {
      console.error('[Paywall] Unlock error:', err)
      statusEl.textContent = 'Error: ' + (err.message || 'unknown')
      statusEl.className = 'paywall-modal-status error'
      confirmBtn.disabled = false
      cancelBtn.disabled = false
    }
  })
}
