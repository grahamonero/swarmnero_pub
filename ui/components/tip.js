/**
 * Tip component - Monero tipping flow for posts
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { formatTime, getDisplayName } from '../utils/format.js'
import * as wallet from '../../lib/wallet.js'
import { getXMRPrice, formatXMRWithUSD } from '../../lib/price.js'
import { createTipEvent } from '../../lib/events.js'
import { pushPanel } from './panel.js'

// Module state
let refreshUICallback = null
let currentPost = null
let pendingTxData = null
let xmrPrice = null

// Constants
const ATOMIC_UNITS_PER_XMR = 1000000000000n
const MAX_CONTENT_PREVIEW = 100

/**
 * Initialize tip component
 * @param {Function} refreshUI - Callback to refresh UI after tip
 */
export function initTip(refreshUI) {
  refreshUICallback = refreshUI

  // Get modal elements
  const modal = document.getElementById('tipModal')
  if (!modal) return

  // Close button handler
  const closeBtn = modal.querySelector('.modal-close')
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      closeTipModal()
    })
  }

  // Cancel button handler
  const cancelBtn = document.getElementById('tipCancel')
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      closeTipModal()
    })
  }

  // Preview button handler
  const previewBtn = document.getElementById('tipPreview')
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      handlePreview()
    })
  }

  // Confirm button handler
  const confirmBtn = document.getElementById('tipConfirm')
  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      handleConfirm()
    })
  }

  // Back button handler (return to amount entry)
  const backBtn = document.getElementById('tipBack')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      showAmountStep()
    })
  }

  // Done button handler (close modal after success)
  const doneBtn = document.getElementById('tipDone')
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      closeTipModal()
    })
  }

  // Amount input - enter key support and real-time USD update
  const amountInput = document.getElementById('tipAmount')
  const amountUSD = document.getElementById('tipAmountUSD')
  if (amountInput) {
    amountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handlePreview()
      }
    })

    // Real-time USD equivalent as user types
    amountInput.addEventListener('input', () => {
      if (!amountUSD) return
      const amountStr = amountInput.value.trim()
      if (!amountStr || !xmrPrice) {
        amountUSD.textContent = ''
        return
      }
      try {
        const amountNum = parseFloat(amountStr)
        if (isNaN(amountNum) || amountNum <= 0) {
          amountUSD.textContent = ''
          return
        }
        const usdValue = amountNum * xmrPrice
        amountUSD.textContent = `≈ $${usdValue.toFixed(2)} USD`
      } catch {
        amountUSD.textContent = ''
      }
    })
  }

  // Click outside modal to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeTipModal()
    }
  })

  // QR step handlers
  const qrCopyBtn = document.getElementById('tipQRCopy')
  if (qrCopyBtn) {
    qrCopyBtn.addEventListener('click', async () => {
      const address = document.getElementById('tipQRAddress')?.textContent
      if (address) {
        try {
          await navigator.clipboard.writeText(address)
          qrCopyBtn.textContent = 'Copied!'
          setTimeout(() => { qrCopyBtn.textContent = 'Copy Address' }, 2000)
        } catch (err) {
          console.error('Copy failed:', err)
        }
      }
    })
  }

  const qrUnlockBtn = document.getElementById('tipQRUnlock')
  if (qrUnlockBtn) {
    qrUnlockBtn.addEventListener('click', () => {
      closeTipModal()
      // Navigate to wallet panel to unlock
      pushPanel('wallet')
    })
  }

  const qrCloseBtn = document.getElementById('tipQRClose')
  if (qrCloseBtn) {
    qrCloseBtn.addEventListener('click', () => {
      closeTipModal()
    })
  }

  // No tip address modal handler
  const noTipAddressModal = document.getElementById('noTipAddressModal')
  const noTipAddressClose = document.getElementById('noTipAddressClose')
  if (noTipAddressClose && noTipAddressModal) {
    noTipAddressClose.addEventListener('click', () => {
      noTipAddressModal.classList.add('hidden')
    })
    noTipAddressModal.addEventListener('click', (e) => {
      if (e.target === noTipAddressModal) {
        noTipAddressModal.classList.add('hidden')
      }
    })
  }
}

/**
 * Show the tip modal for a post
 * @param {Object} post - Post object with pubkey, timestamp, content, subaddress
 */
export async function showTipModal(post) {
  if (!post) return

  // Determine tip address first
  const tipResult = getTipAddress(post)

  // Flow 3: No tip address - show dedicated modal
  if (!tipResult) {
    const noTipModal = document.getElementById('noTipAddressModal')
    if (noTipModal) {
      noTipModal.classList.remove('hidden')
    }
    return
  }

  const { address: tipAddress, isProfileFallback } = tipResult

  const modal = document.getElementById('tipModal')
  if (!modal) return

  // Store current post
  currentPost = post
  pendingTxData = null

  // Fetch current XMR price
  xmrPrice = await getXMRPrice()

  // Get author display name
  const displayName = getDisplayName(
    post.pubkey,
    state.identity,
    state.myProfile,
    state.peerProfiles
  )

  // Truncate content for preview
  let contentPreview = post.content || ''
  if (contentPreview.length > MAX_CONTENT_PREVIEW) {
    contentPreview = contentPreview.slice(0, MAX_CONTENT_PREVIEW) + '...'
  }

  // Update modal content
  const authorEl = document.getElementById('tipAuthor')
  const previewEl = document.getElementById('tipPostPreview')
  const addressEl = document.getElementById('tipAddress')
  const amountInput = document.getElementById('tipAmount')
  const errorEl = document.getElementById('tipError')
  const fallbackNoticeEl = document.getElementById('tipFallbackNotice')

  if (authorEl) authorEl.textContent = displayName
  if (previewEl) previewEl.textContent = contentPreview
  if (addressEl) {
    addressEl.textContent = tipAddress.slice(0, 16) + '...' + tipAddress.slice(-8)
    addressEl.title = tipAddress
  }
  if (amountInput) amountInput.value = ''
  if (errorEl) {
    errorEl.textContent = ''
    errorEl.classList.add('hidden')
  }
  // Clear USD preview
  const amountUSD = document.getElementById('tipAmountUSD')
  if (amountUSD) amountUSD.textContent = ''

  // Show fallback notice if using profile address instead of post-specific address
  if (fallbackNoticeEl) {
    if (isProfileFallback) {
      fallbackNoticeEl.innerHTML = `<strong>Note:</strong> This post was created before ${escapeHtml(displayName)} set up their wallet. Your tip will go to their general address and won't be linked to this specific post.`
      fallbackNoticeEl.classList.remove('hidden')
    } else {
      fallbackNoticeEl.classList.add('hidden')
    }
  }

  // Flow 2: Wallet locked but address exists - show QR code
  if (!wallet.isWalletUnlocked()) {
    showLockedQRStep(tipAddress, isProfileFallback, displayName)
    modal.classList.remove('hidden')
    return
  }

  // Flow 1: Wallet unlocked - normal amount entry flow
  showAmountStep()

  // Show modal
  modal.classList.remove('hidden')

  // Focus amount input
  if (amountInput) {
    amountInput.focus()
  }
}

/**
 * Show the locked wallet QR code step
 */
function showLockedQRStep(tipAddress, isProfileFallback = false, authorName = '') {
  const amountStep = document.getElementById('tipAmountStep')
  const lockedQRStep = document.getElementById('tipLockedQRStep')
  const confirmStep = document.getElementById('tipConfirmStep')
  const successStep = document.getElementById('tipSuccessStep')

  if (amountStep) amountStep.classList.add('hidden')
  if (lockedQRStep) lockedQRStep.classList.remove('hidden')
  if (confirmStep) confirmStep.classList.add('hidden')
  if (successStep) successStep.classList.add('hidden')

  // Generate QR code
  const qrContainer = document.getElementById('tipQRContainer')
  const qrAddressEl = document.getElementById('tipQRAddress')
  const qrFallbackNoticeEl = document.getElementById('tipQRFallbackNotice')

  if (qrAddressEl) {
    qrAddressEl.textContent = tipAddress
  }

  // Show fallback notice in QR step too
  if (qrFallbackNoticeEl) {
    if (isProfileFallback) {
      qrFallbackNoticeEl.innerHTML = `<strong>Note:</strong> This post was created before ${escapeHtml(authorName)} set up their wallet. Your tip will go to their general address.`
      qrFallbackNoticeEl.classList.remove('hidden')
    } else {
      qrFallbackNoticeEl.classList.add('hidden')
    }
  }

  if (qrContainer && typeof QRCode !== 'undefined') {
    qrContainer.innerHTML = ''
    new QRCode(qrContainer, {
      text: `monero:${tipAddress}`,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    })
  }
}

/**
 * Close the tip modal
 */
function closeTipModal() {
  const modal = document.getElementById('tipModal')
  if (modal) {
    modal.classList.add('hidden')
  }

  // Cancel any pending transaction
  if (pendingTxData) {
    wallet.cancelPendingTransaction()
    pendingTxData = null
  }

  currentPost = null
}

/**
 * Get the tip address for a post
 * First checks post.subaddress, then author's profile monero_address
 * Also checks by swarm ID mapping for peers
 * Returns { address, isProfileFallback } or null
 */
function getTipAddress(post) {
  // Use post subaddress if available (highest priority)
  if (post.subaddress) {
    return { address: post.subaddress, isProfileFallback: false }
  }

  // Look up author's profile monero address
  const isMe = post.pubkey === state.identity?.pubkeyHex

  // For own posts, use myProfile
  if (isMe && state.myProfile?.monero_address) {
    return { address: state.myProfile.monero_address, isProfileFallback: true }
  }

  // For peer posts, try direct pubkey lookup first
  if (!isMe) {
    // Direct lookup by pubkey
    let profile = state.peerProfiles[post.pubkey]

    // If not found, try looking up via swarm ID mapping
    // Some posts might have different pubkey formats
    if (!profile) {
      for (const [swarmId, pubkey] of Object.entries(state.swarmIdToPubkey)) {
        if (pubkey === post.pubkey) {
          profile = state.peerProfiles[pubkey]
          break
        }
      }
    }

    if (profile?.monero_address) {
      return { address: profile.monero_address, isProfileFallback: true }
    }
  }

  return null
}

/**
 * Show the amount entry step
 */
function showAmountStep() {
  const amountStep = document.getElementById('tipAmountStep')
  const lockedQRStep = document.getElementById('tipLockedQRStep')
  const confirmStep = document.getElementById('tipConfirmStep')
  const successStep = document.getElementById('tipSuccessStep')

  if (amountStep) amountStep.classList.remove('hidden')
  if (lockedQRStep) lockedQRStep.classList.add('hidden')
  if (confirmStep) confirmStep.classList.add('hidden')
  if (successStep) successStep.classList.add('hidden')

  // Cancel pending tx if any
  if (pendingTxData) {
    wallet.cancelPendingTransaction()
    pendingTxData = null
  }
}

/**
 * Show the confirmation step
 */
function showConfirmStep() {
  const amountStep = document.getElementById('tipAmountStep')
  const lockedQRStep = document.getElementById('tipLockedQRStep')
  const confirmStep = document.getElementById('tipConfirmStep')
  const successStep = document.getElementById('tipSuccessStep')

  if (amountStep) amountStep.classList.add('hidden')
  if (lockedQRStep) lockedQRStep.classList.add('hidden')
  if (confirmStep) confirmStep.classList.remove('hidden')
  if (successStep) successStep.classList.add('hidden')
}

/**
 * Show the success step
 */
function showSuccessStep(txHash) {
  const amountStep = document.getElementById('tipAmountStep')
  const lockedQRStep = document.getElementById('tipLockedQRStep')
  const confirmStep = document.getElementById('tipConfirmStep')
  const successStep = document.getElementById('tipSuccessStep')
  const txHashEl = document.getElementById('tipTxHash')

  if (amountStep) amountStep.classList.add('hidden')
  if (lockedQRStep) lockedQRStep.classList.add('hidden')
  if (confirmStep) confirmStep.classList.add('hidden')
  if (successStep) successStep.classList.remove('hidden')

  if (txHashEl) {
    txHashEl.textContent = txHash
    txHashEl.title = txHash
  }
}

/**
 * Show error message
 */
function showError(message) {
  const errorEl = document.getElementById('tipError')
  if (errorEl) {
    errorEl.textContent = message
    errorEl.classList.remove('hidden')
  }
}

/**
 * Hide error message
 */
function hideError() {
  const errorEl = document.getElementById('tipError')
  if (errorEl) {
    errorEl.textContent = ''
    errorEl.classList.add('hidden')
  }
}

/**
 * Handle preview button click - create transaction to get fee
 */
async function handlePreview() {
  const amountInput = document.getElementById('tipAmount')
  const previewBtn = document.getElementById('tipPreview')

  if (!amountInput || !currentPost) return

  const amountStr = amountInput.value.trim()
  if (!amountStr) {
    showError('Please enter an amount')
    return
  }

  // Validate amount format
  let amountAtomic
  try {
    amountAtomic = wallet.parseXMR(amountStr)
    if (amountAtomic <= 0n) {
      showError('Amount must be greater than 0')
      return
    }
  } catch (err) {
    showError('Invalid amount format')
    return
  }

  const tipResult = getTipAddress(currentPost)
  if (!tipResult) {
    showError('No tip address available')
    return
  }
  const tipAddress = tipResult.address

  if (!wallet.isWalletUnlocked()) {
    showError('Wallet is locked. Please unlock your wallet first.')
    return
  }

  hideError()

  // Disable button while creating tx
  if (previewBtn) {
    previewBtn.disabled = true
    previewBtn.textContent = 'Creating transaction...'
  }

  try {
    // Create transaction to get fee
    const { fee, tx } = await wallet.createTransaction(tipAddress, amountAtomic)

    // Store pending tx data
    pendingTxData = {
      amount: amountAtomic,
      fee,
      tx,
      address: tipAddress
    }

    // Calculate total
    const total = amountAtomic + fee

    // Update confirmation display
    const confirmAmountEl = document.getElementById('tipConfirmAmount')
    const confirmFeeEl = document.getElementById('tipConfirmFee')
    const confirmTotalEl = document.getElementById('tipConfirmTotal')

    // Format with USD equivalents
    const amountNum = Number(amountAtomic) / Number(ATOMIC_UNITS_PER_XMR)
    const feeNum = Number(fee) / Number(ATOMIC_UNITS_PER_XMR)
    const totalNum = Number(total) / Number(ATOMIC_UNITS_PER_XMR)

    if (confirmAmountEl) {
      confirmAmountEl.textContent = formatXMRWithUSD(Number(amountAtomic), xmrPrice)
    }
    if (confirmFeeEl) {
      confirmFeeEl.textContent = formatXMRWithUSD(Number(fee), xmrPrice)
    }
    if (confirmTotalEl) {
      confirmTotalEl.textContent = formatXMRWithUSD(Number(total), xmrPrice)
    }

    // Show confirmation step
    showConfirmStep()
  } catch (err) {
    console.error('[Tip] Error creating transaction:', err)

    // Handle specific errors
    if (err.message.includes('not enough')) {
      showError('Insufficient balance for this transaction')
    } else if (err.message.includes('locked')) {
      showError('Wallet is locked. Please unlock your wallet first.')
    } else {
      showError('Error: ' + err.message)
    }
  } finally {
    if (previewBtn) {
      previewBtn.disabled = false
      previewBtn.textContent = 'Preview'
    }
  }
}

/**
 * Handle confirm button click - relay transaction
 */
async function handleConfirm() {
  const confirmBtn = document.getElementById('tipConfirm')

  if (!pendingTxData || !currentPost) {
    showError('No pending transaction')
    return
  }

  if (!wallet.isWalletUnlocked()) {
    showError('Wallet is locked')
    return
  }

  hideError()

  // Disable button while relaying
  if (confirmBtn) {
    confirmBtn.disabled = true
    confirmBtn.textContent = 'Sending...'
  }

  try {
    // Relay the transaction
    const { txHash, txKey } = await wallet.relayTransaction()

    // Save the tip-to-post mapping for later lookup (includes proof for local records)
    const txProof = txKey ? `${txHash}:${txKey}` : txHash
    wallet.saveTipPostMapping(txHash, currentPost.pubkey, currentPost.timestamp, txProof)

    // Immediately refresh wallet tx history so it appears in UI
    await wallet.refreshAfterSend()

    // Queue TIP event for delayed broadcast (privacy)
    // Tips are batched and shuffled to break timing correlation with blockchain transactions
    const tipEvent = createTipEvent({
      toSwarmId: getSwarmIdForPubkey(currentPost.pubkey),
      postIndex: currentPost.timestamp, // Using timestamp as post identifier
      amount: wallet.formatXMR(pendingTxData.amount)
      // tx_proof intentionally not included - stored locally only
    })

    if (state.tipBatcher) {
      // Use tip batcher for delayed broadcast (recommended for privacy)
      state.tipBatcher.queue(tipEvent)
    } else if (state.feed) {
      // Fallback to immediate broadcast if batcher not available
      await state.feed.append(tipEvent)
    }

    // Clear pending tx
    pendingTxData = null

    // Show success
    showSuccessStep(txHash)

    // Refresh UI if callback provided
    if (refreshUICallback) {
      await refreshUICallback()
    }
  } catch (err) {
    console.error('[Tip] Error relaying transaction:', err)
    showError('Error sending tip: ' + err.message)

    // Re-enable button to allow retry
    if (confirmBtn) {
      confirmBtn.disabled = false
      confirmBtn.textContent = 'Confirm'
    }
  }
}

/**
 * Get Swarm ID for a pubkey
 * Looks up in swarmIdToPubkey map (reverse lookup)
 */
function getSwarmIdForPubkey(pubkey) {
  // Check if it's our own pubkey
  if (pubkey === state.identity?.pubkeyHex) {
    return state.accountManager?.exportSwarmId(state.activeAccountName) || pubkey
  }

  // Reverse lookup in swarmIdToPubkey
  for (const [swarmId, pk] of Object.entries(state.swarmIdToPubkey)) {
    if (pk === pubkey) {
      return swarmId
    }
  }

  // Fallback to pubkey if swarm ID not found
  return pubkey
}
