/**
 * Wallet panel UI component
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import * as wallet from '../../lib/wallet.js'
import { getXMRPrice, formatXMRWithUSD } from '../../lib/price.js'
import { popPanel, pushPanel } from './panel.js'
import { updateProfileWithNewSubaddress } from './profile.js'

// Callback for refreshing UI
let refreshUICallback = null

// Cached price
let xmrPrice = null

// Track if privacy notice has been shown this session
let privacyNoticeShown = false

/**
 * Show privacy notice (once per session)
 * Explains that IP is visible to peers and recommends VPN for privacy
 */
function showPrivacyNotice() {
  if (privacyNoticeShown) return
  privacyNoticeShown = true

  // Create modal overlay
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay privacy-notice-overlay'
  overlay.innerHTML = `
    <div class="privacy-notice-modal">
      <h3>Privacy Notice</h3>
      <p><strong>Your IP address is visible to peers you connect with.</strong></p>
      <p>Swarmnero is a peer-to-peer application. While Monero protects your
      on-chain transaction privacy, peers in the swarm can see your IP address
      when you connect.</p>
      <p><strong>Tor does not work with Swarmnero.</strong> The peer-to-peer
      network uses UDP, which Tor cannot route. Even if you have Tor running
      on your machine, your real IP will still be visible to peers.</p>
      <p>For stronger privacy, use a VPN that routes UDP traffic.</p>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="privacyNoticeOk">I understand</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  document.getElementById('privacyNoticeOk').addEventListener('click', () => {
    overlay.remove()
  })
}

/**
 * Initialize wallet component
 */
export function initWallet(refreshUI) {
  refreshUICallback = refreshUI

  // Create wallet modal handlers
  const createWalletSubmit = document.getElementById('createWalletSubmit')
  const createWalletCancel = document.getElementById('createWalletCancel')

  if (createWalletSubmit) {
    createWalletSubmit.addEventListener('click', handleCreateWallet)
  }
  if (createWalletCancel) {
    createWalletCancel.addEventListener('click', () => {
      document.getElementById('createWalletModal')?.classList.add('hidden')
    })
  }

  // Restore wallet modal handlers
  const restoreWalletSubmit = document.getElementById('restoreWalletSubmit')
  const restoreWalletCancel = document.getElementById('restoreWalletCancel')

  if (restoreWalletSubmit) {
    restoreWalletSubmit.addEventListener('click', handleRestoreWallet)
  }
  if (restoreWalletCancel) {
    restoreWalletCancel.addEventListener('click', () => {
      document.getElementById('restoreWalletModal')?.classList.add('hidden')
    })
  }

  // Unlock modal handlers
  const unlockWalletSubmit = document.getElementById('unlockWalletSubmit')
  const unlockWalletCancel = document.getElementById('unlockWalletCancel')

  if (unlockWalletSubmit) {
    unlockWalletSubmit.addEventListener('click', handleUnlock)
  }
  if (unlockWalletCancel) {
    unlockWalletCancel.addEventListener('click', () => {
      document.getElementById('unlockWalletModal')?.classList.add('hidden')
    })
  }

  // Send preview modal handlers
  const sendConfirmBtn = document.getElementById('sendPreviewConfirm')
  const sendCancelBtn = document.getElementById('sendPreviewCancel')

  if (sendConfirmBtn) {
    sendConfirmBtn.addEventListener('click', handleConfirmSend)
  }
  if (sendCancelBtn) {
    sendCancelBtn.addEventListener('click', () => {
      wallet.cancelPendingTransaction()
      document.getElementById('sendPreviewModal')?.classList.add('hidden')
    })
  }

  // Delete wallet modal handlers
  const deleteWalletSubmit = document.getElementById('deleteWalletSubmit')
  const deleteWalletCancel = document.getElementById('deleteWalletCancel')

  if (deleteWalletSubmit) {
    deleteWalletSubmit.addEventListener('click', handleDeleteWalletSubmit)
  }
  if (deleteWalletCancel) {
    deleteWalletCancel.addEventListener('click', () => {
      document.getElementById('deleteWalletPassword').value = ''
      document.getElementById('deleteWalletModal')?.classList.add('hidden')
    })
  }

  // Enter key support for password inputs
  document.getElementById('createWalletPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createWalletSubmit?.click()
  })
  document.getElementById('restoreWalletPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restoreWalletSubmit?.click()
  })
  document.getElementById('unlockWalletPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') unlockWalletSubmit?.click()
  })
  document.getElementById('deleteWalletPassword')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') deleteWalletSubmit?.click()
  })

  // QR code modal handlers
  const qrCodeClose = document.getElementById('qrCodeClose')
  const qrCodeCopy = document.getElementById('qrCodeCopy')

  if (qrCodeClose) {
    qrCodeClose.addEventListener('click', () => {
      document.getElementById('qrCodeModal')?.classList.add('hidden')
    })
  }

  if (qrCodeCopy) {
    qrCodeCopy.addEventListener('click', async () => {
      const addressEl = document.getElementById('qrCodeAddress')
      const address = addressEl?.textContent || ''
      if (address) {
        await navigator.clipboard.writeText(address)
        qrCodeCopy.textContent = 'Copied!'
        setTimeout(() => { qrCodeCopy.textContent = 'Copy' }, 2000)
      }
    })
  }

  // Back button handler - uses navigation stack
  const walletBackBtn = document.getElementById('walletBackBtn')
  if (walletBackBtn) {
    walletBackBtn.addEventListener('click', () => {
      popPanel()
    })
  }

  // Transaction details modal handlers
  const txDetailsClose = document.getElementById('txDetailsClose')
  const txDetailsCopy = document.getElementById('txDetailsCopy')

  if (txDetailsClose) {
    txDetailsClose.addEventListener('click', () => {
      document.getElementById('txDetailsModal')?.classList.add('hidden')
    })
  }

  if (txDetailsCopy) {
    txDetailsCopy.addEventListener('click', async () => {
      const txidEl = document.getElementById('txDetailTxid')
      const txid = txidEl?.textContent || ''
      if (txid) {
        await navigator.clipboard.writeText(txid)
        txDetailsCopy.textContent = 'Copied!'
        setTimeout(() => { txDetailsCopy.textContent = 'Copy TX ID' }, 2000)
      }
    })
  }

  // Seed modal handlers
  const seedClose = document.getElementById('seedClose')
  const seedCopyBtn = document.getElementById('seedCopyBtn')

  if (seedClose) {
    seedClose.addEventListener('click', () => {
      document.getElementById('seedModal')?.classList.add('hidden')
    })
  }

  if (seedCopyBtn) {
    seedCopyBtn.addEventListener('click', async () => {
      const seedDisplay = document.getElementById('seedDisplay')
      const seed = seedDisplay?.textContent || ''
      if (seed) {
        await navigator.clipboard.writeText(seed)
        seedCopyBtn.textContent = 'Copied!'
        setTimeout(() => { seedCopyBtn.textContent = 'Copy Seed' }, 2000)
      }
    })
  }
}

/**
 * Render wallet panel based on state
 */
export async function renderWalletPanel() {
  if (!dom.walletContent) return

  // Note: Panel visibility is now handled by panel.js navigation system

  const accountName = state.activeAccountName
  if (!accountName) {
    dom.walletContent.innerHTML = '<div class="empty">No account selected</div>'
    return
  }

  // Fetch price in background
  getXMRPrice().then(p => { xmrPrice = p })

  const hasWalletForAccount = await wallet.hasWallet(accountName)

  if (!hasWalletForAccount) {
    renderNoWalletState()
    return
  }

  const isUnlocked = wallet.isWalletUnlocked()

  if (!isUnlocked) {
    await renderLockedState(accountName)
  } else {
    // If we haven't synced yet this session, show sync progress UI
    const syncStatus = wallet.getSyncStatus()
    if (!syncStatus.hasSyncedThisSession) {
      await renderUnlockedStateWithSync(accountName)
    } else {
      await renderUnlockedState(accountName)
    }
  }
}

/**
 * Render state when no wallet exists
 */
function renderNoWalletState() {
  dom.walletContent.innerHTML = `
    <div class="wallet-empty">
      <p>No wallet configured for this account.</p>
      <div class="wallet-actions">
        <button id="createWalletBtn" class="btn">Create Wallet</button>
        <button id="restoreWalletBtn" class="btn secondary-btn">Restore Wallet</button>
      </div>
    </div>
  `

  document.getElementById('createWalletBtn')?.addEventListener('click', showCreateWalletModal)
  document.getElementById('restoreWalletBtn')?.addEventListener('click', showRestoreWalletModal)
}

/**
 * Render locked wallet state
 */
async function renderLockedState(accountName) {
  const meta = await wallet.getWalletMeta(accountName)
  const address = meta?.primaryAddress
  const shortAddress = address ? `${address.slice(0, 12)}...${address.slice(-8)}` : 'Unknown'
  const restoreHeight = meta?.restoreHeight || 0
  const lastSynced = meta?.lastSyncedHeight

  let syncStatus = `Restore height: ${restoreHeight.toLocaleString()}`
  if (lastSynced) {
    syncStatus += ` | Last synced: ${lastSynced.toLocaleString()}`
  }

  dom.walletContent.innerHTML = `
    <div class="wallet-locked">
      <div class="wallet-address-display">
        <span class="label">Address:</span>
        <code>${escapeHtml(shortAddress)}</code>
      </div>
      <div class="wallet-sync-info">
        <span class="label">${syncStatus}</span>
        <button id="copyRestoreHeightBtn" class="btn small" title="Copy restore height">Copy Height</button>
      </div>
      <button id="unlockWalletBtn" class="btn">Unlock Wallet</button>
      <div class="wallet-danger-zone" style="margin-top: 16px;">
        <button id="deleteWalletLockedBtn" class="btn danger-btn small">Delete Wallet</button>
      </div>
    </div>
  `

  document.getElementById('unlockWalletBtn')?.addEventListener('click', showUnlockModal)
  document.getElementById('copyRestoreHeightBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('copyRestoreHeightBtn')
    await navigator.clipboard.writeText(restoreHeight.toString())
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy Height' }, 2000)
  })
  document.getElementById('deleteWalletLockedBtn')?.addEventListener('click', handleDeleteWalletLocked)
}

/**
 * Handle delete wallet from locked state (requires password)
 */
function handleDeleteWalletLocked() {
  showDeleteWalletModal()
}

/**
 * Show delete wallet modal
 */
function showDeleteWalletModal() {
  const modal = document.getElementById('deleteWalletModal')
  if (modal) {
    modal.classList.remove('hidden')
    document.getElementById('deleteWalletPassword')?.focus()
  }
}

/**
 * Handle delete wallet submission
 */
async function handleDeleteWalletSubmit() {
  const passwordInput = document.getElementById('deleteWalletPassword')
  const btn = document.getElementById('deleteWalletSubmit')
  const password = passwordInput.value

  if (!password) {
    alert('Please enter your password')
    return
  }

  btn.disabled = true
  btn.textContent = 'Deleting...'

  try {
    await wallet.deleteWallet(state.activeAccountName, password)
    passwordInput.value = ''
    document.getElementById('deleteWalletModal')?.classList.add('hidden')
    alert('Wallet deleted.')
    await renderWalletPanel()
  } catch (e) {
    alert('Error: ' + e.message)
  }

  btn.disabled = false
  btn.textContent = 'Delete Wallet'
}

/**
 * Render unlocked wallet state
 */
async function renderUnlockedState(accountName) {
  let balanceDisplay = '<span class="sync-needed">Sync to see balance</span>'
  let txHistory = []
  let nodeAvailable = false
  let nodeInfo = null

  // Get node info
  try {
    nodeInfo = wallet.getSelectedNode()
  } catch (e) {
    console.warn('[Wallet UI] Could not get node info:', e.message)
  }

  try {
    const { balance, unlockedBalance } = await wallet.getBalance()
    nodeAvailable = true
    const balanceNum = Number(balance) / 1e12
    balanceDisplay = xmrPrice
      ? `${balanceNum.toFixed(8)} XMR (~$${Math.abs(balanceNum * xmrPrice).toFixed(2)})`
      : `${balanceNum.toFixed(8)} XMR`

    if (unlockedBalance < balance) {
      const lockedNum = Number(balance - unlockedBalance) / 1e12
      balanceDisplay += `<br><span class="locked-balance">${lockedNum.toFixed(8)} XMR locked pending confirmation</span>`
    }
  } catch (e) {
    console.warn('[Wallet] Balance unavailable:', e.message)
    // Balance unavailable - likely no node connection
  }

  if (nodeAvailable) {
    try {
      txHistory = await wallet.getTransactions()
    } catch (e) {
      console.warn('Error loading transactions:', e)
    }
  }

  // Get address from storage (doesn't need node)
  const address = await wallet.getPrimaryAddress(accountName)
  const shortAddress = address ? `${address.slice(0, 16)}...${address.slice(-8)}` : ''

  // Meta for the Settings submenu
  const unlockedMeta = await wallet.getWalletMeta(accountName)
  const restoreHeightDisplay = (unlockedMeta?.restoreHeight ?? 0).toLocaleString()
  const syncHeightDisplay = unlockedMeta?.lastSyncedHeight != null
    ? unlockedMeta.lastSyncedHeight.toLocaleString()
    : 'Not synced yet'

  // Format node info for display
  let nodeDisplay = ''
  if (nodeInfo) {
    // Extract hostname from URL for compact display
    try {
      const url = new URL(nodeInfo.url)
      nodeDisplay = `${url.hostname} (${nodeInfo.latency}ms)`
    } catch {
      nodeDisplay = `${nodeInfo.url} (${nodeInfo.latency}ms)`
    }
  }

  // Get sync status for display
  const syncStatus = wallet.getSyncStatus()
  let syncDisplay = ''
  if (syncStatus.lastSyncTime) {
    const ago = Math.floor((Date.now() - syncStatus.lastSyncTime) / 1000)
    if (ago < 60) {
      syncDisplay = 'Synced just now'
    } else if (ago < 3600) {
      syncDisplay = `Synced ${Math.floor(ago / 60)}m ago`
    } else {
      syncDisplay = `Synced ${Math.floor(ago / 3600)}h ago`
    }
  }

  dom.walletContent.innerHTML = `
    <div class="wallet-unlocked">
      <div class="wallet-balance">
        <span class="label">Balance:</span>
        <span class="value">${balanceDisplay}</span>
      </div>

      ${nodeDisplay ? `
      <div class="wallet-node-info">
        <span class="label">Node:</span>
        <span class="value node-value">${escapeHtml(nodeDisplay)}</span>
      </div>
      ` : ''}

      ${syncDisplay ? `
      <div class="wallet-sync-status">
        <span class="sync-indicator synced"></span>
        <span class="sync-text">${escapeHtml(syncDisplay)}</span>
      </div>
      ` : ''}

      <div class="wallet-toolbar">
        <button id="lockWalletBtn" class="btn small">Lock</button>
        <button id="syncWalletBtn" class="btn small">Sync</button>
      </div>

      <div class="wallet-section">
        <h4>Receive</h4>
        <div class="wallet-receive">
          <code id="receiveAddress">${escapeHtml(shortAddress)}</code>
          <button id="copyAddressBtn" class="btn small" title="Copy address">Copy</button>
          <button id="qrAddressBtn" class="btn small" title="Show QR code">QR</button>
          <button id="newAddressBtn" class="btn small secondary-btn" title="Generate new subaddress">New</button>
        </div>
      </div>

      <div class="wallet-section collapsible collapsed" id="walletSettingsSection">
        <h4 class="collapsible-header" id="walletSettingsHeader">
          <span class="chevron">&#9654;</span> Settings
        </h4>
        <div class="collapsible-content">
          <div class="wallet-heights">
            <div class="wallet-height-row">
              <span class="label">Restore height:</span>
              <span class="value">${restoreHeightDisplay}</span>
            </div>
            <div class="wallet-height-row">
              <span class="label">Current sync height:</span>
              <span class="value">${syncHeightDisplay}</span>
            </div>
          </div>
          <div class="wallet-danger-zone">
            <button id="showSeedBtn" class="btn danger-btn small">Show Seed</button>
            <button id="deleteWalletBtn" class="btn danger-btn small">Delete Wallet</button>
          </div>
        </div>
      </div>

      <div class="wallet-section">
        <h4>Send</h4>
        <div class="wallet-send-form">
          <input type="text" id="sendAddress" placeholder="Recipient address" class="input">
          <div class="send-amount-row">
            <input type="text" id="sendAmount" placeholder="Amount (XMR)" class="input">
            <button id="previewSendBtn" class="btn">Preview</button>
          </div>
        </div>
      </div>

      <div id="syncProgress" class="sync-progress hidden">
        <div class="progress-bar"><div class="progress-fill" id="syncProgressFill"></div></div>
        <span id="syncProgressText">Syncing...</span>
      </div>

      <div class="wallet-section">
        <h4>Transactions</h4>
        <div id="txHistory" class="tx-history">
          ${renderTransactionHistory(txHistory)}
        </div>
      </div>
    </div>
  `

  bindUnlockedHandlers()
}

/**
 * Render transaction history
 */
function renderTransactionHistory(txs) {
  if (!txs || txs.length === 0) {
    return '<div class="empty">No transactions yet</div>'
  }

  const CONFIRMATION_THRESHOLD = 10

  return txs.map(tx => {
    const amountNum = Number(tx.amount) / 1e12
    const amountStr = amountNum.toFixed(8)
    const typeClass = tx.isIncoming ? 'incoming' : 'outgoing'
    const sign = tx.isIncoming ? '+' : '-'
    const date = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleDateString() : ''

    let usdStr = ''
    if (xmrPrice) {
      usdStr = ` (~$${Math.abs(amountNum * xmrPrice).toFixed(2)})`
    }

    // Determine confirmation status
    const confirmations = tx.confirmations || 0
    const isConfirmed = confirmations >= CONFIRMATION_THRESHOLD
    let statusDisplay = ''

    if (isConfirmed) {
      // Show green checkmark when confirmed (10+ confirmations)
      statusDisplay = '<span class="tx-confirmed" title="Confirmed">&#10003;</span>'
    } else if (confirmations > 0) {
      // Show confirmation count when partially confirmed
      statusDisplay = `<span class="tx-pending" title="${confirmations} confirmations">${confirmations} conf</span>`
    } else {
      // Show pending when no confirmations
      statusDisplay = '<span class="tx-pending">Pending</span>'
    }

    // Add data-txid attribute for click handling
    const txid = tx.txid || ''

    return `
      <div class="tx-item ${typeClass}" data-txid="${escapeHtml(txid)}" title="Click for details">
        <span class="tx-amount">${sign}${amountStr} XMR${usdStr}</span>
        <span class="tx-status">${statusDisplay}</span>
        ${date ? `<span class="tx-date">${date}</span>` : ''}
      </div>
    `
  }).join('')
}

/**
 * Bind event handlers for unlocked state
 */
function bindUnlockedHandlers() {
  // Lock button
  document.getElementById('lockWalletBtn')?.addEventListener('click', async () => {
    await wallet.lock()
    await renderWalletPanel()
  })

  // Sync button
  document.getElementById('syncWalletBtn')?.addEventListener('click', handleSync)

  // Copy address
  document.getElementById('copyAddressBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('copyAddressBtn')
    try {
      const { address } = await wallet.getReceiveAddress(false)
      await navigator.clipboard.writeText(address)
      btn.textContent = 'Copied!'
      setTimeout(() => { btn.textContent = 'Copy' }, 2000)
    } catch (e) {
      alert('Error copying address: ' + e.message)
    }
  })

  // New address
  document.getElementById('newAddressBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('newAddressBtn')
    btn.disabled = true
    try {
      const { address } = await wallet.getReceiveAddress(true)
      const shortAddress = `${address.slice(0, 16)}...${address.slice(-8)}`
      document.getElementById('receiveAddress').textContent = shortAddress
      await navigator.clipboard.writeText(address)
      alert('New subaddress generated and copied!')
    } catch (e) {
      alert('Error generating address: ' + e.message)
    }
    btn.disabled = false
  })

  // QR code button
  document.getElementById('qrAddressBtn')?.addEventListener('click', async () => {
    try {
      const { address } = await wallet.getReceiveAddress(false)
      showQRCode(address)
    } catch (e) {
      alert('Error getting address: ' + e.message)
    }
  })

  // Preview send
  document.getElementById('previewSendBtn')?.addEventListener('click', handlePreviewSend)

  // Show seed
  document.getElementById('showSeedBtn')?.addEventListener('click', () => {
    try {
      const seed = wallet.getSeed()
      const seedDisplay = document.getElementById('seedDisplay')
      const seedModal = document.getElementById('seedModal')
      if (seedDisplay && seedModal) {
        seedDisplay.textContent = seed
        seedModal.classList.remove('hidden')
      }
    } catch (e) {
      alert('Error: ' + e.message)
    }
  })

  // Delete wallet
  document.getElementById('deleteWalletBtn')?.addEventListener('click', handleDeleteWallet)

  // Collapsible settings section
  document.getElementById('walletSettingsHeader')?.addEventListener('click', () => {
    const section = document.getElementById('walletSettingsSection')
    if (section) {
      section.classList.toggle('collapsed')
    }
  })

  // Transaction row click handlers
  const txHistory = document.getElementById('txHistory')
  if (txHistory) {
    txHistory.addEventListener('click', async (e) => {
      const txItem = e.target.closest('.tx-item')
      if (txItem && txItem.dataset.txid) {
        await showTransactionDetails(txItem.dataset.txid)
      }
    })
  }
}

/**
 * Show QR code modal for an address
 * Uses standard Monero URI format: monero:<address>[?params]
 * This format is recognized by Monerujo, Cake Wallet, and other Monero wallets
 * See: https://github.com/monero-project/monero/wiki/URI-Formatting
 */
function showQRCode(address) {
  const modal = document.getElementById('qrCodeModal')
  const qrContainer = document.getElementById('qrCodeContainer')
  const addressEl = document.getElementById('qrCodeAddress')

  if (!modal || !qrContainer || !addressEl) return

  // Set the address text (raw address for display/copy)
  addressEl.textContent = address

  // Clear previous QR code and create container
  qrContainer.innerHTML = '<div id="qrCodeInner"></div>'

  // Generate QR code with Monero URI format for mobile wallet compatibility
  const moneroUri = `monero:${address}`

  try {
    if (typeof QRCode === 'undefined') {
      throw new Error('QRCode library not loaded')
    }

    new QRCode(document.getElementById('qrCodeInner'), {
      text: moneroUri,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#FFFFFF',
      correctLevel: QRCode.CorrectLevel.M
    })
  } catch (error) {
    console.error('QR code generation failed:', error)
    qrContainer.innerHTML = '<div style="padding: 20px; color: #f85149;">QR code generation failed</div>'
  }

  // Show the modal
  modal.classList.remove('hidden')
}

/**
 * Show transaction details modal
 * Fetches full transaction info including TX key and displays in modal
 */
async function showTransactionDetails(txid) {
  const modal = document.getElementById('txDetailsModal')
  if (!modal) return

  // Get modal elements
  const typeEl = document.getElementById('txDetailType')
  const amountEl = document.getElementById('txDetailAmount')
  const feeEl = document.getElementById('txDetailFee')
  const txidEl = document.getElementById('txDetailTxid')
  const addressEl = document.getElementById('txDetailAddress')
  const keyEl = document.getElementById('txDetailKey')
  const confEl = document.getElementById('txDetailConf')

  // Get post link elements
  const postRow = document.getElementById('txDetailPostRow')
  const viewPostLink = document.getElementById('txDetailViewPost')

  // Set loading state
  typeEl.textContent = 'Loading...'
  typeEl.className = ''
  amountEl.textContent = '...'
  amountEl.className = ''
  feeEl.textContent = '...'
  txidEl.textContent = txid
  addressEl.textContent = 'Loading...'
  keyEl.textContent = 'Loading...'
  confEl.textContent = '...'

  // Hide post row by default
  if (postRow) postRow.classList.add('hidden')

  // Show modal immediately with loading state
  modal.classList.remove('hidden')

  try {
    // Fetch transaction details from wallet
    const details = await wallet.getTransactionDetails(txid)

    // Format amount
    const amountNum = Number(details.amount) / 1e12
    let amountStr = amountNum.toFixed(8) + ' XMR'
    if (xmrPrice) {
      amountStr += ` (~$${Math.abs(amountNum * xmrPrice).toFixed(2)})`
    }

    // Format fee
    const feeNum = Number(details.fee) / 1e12
    let feeStr = feeNum.toFixed(8) + ' XMR'
    if (xmrPrice && feeNum > 0) {
      feeStr += ` (~$${Math.abs(feeNum * xmrPrice).toFixed(4)})`
    }

    // Set type with appropriate styling
    if (details.isIncoming) {
      typeEl.textContent = 'Incoming'
      typeEl.className = 'tx-type-incoming'
      amountEl.textContent = '+' + amountStr
      amountEl.className = 'tx-amount-incoming'
    } else if (details.isOutgoing) {
      typeEl.textContent = 'Outgoing'
      typeEl.className = 'tx-type-outgoing'
      amountEl.textContent = '-' + amountStr
      amountEl.className = 'tx-amount-outgoing'
    } else {
      typeEl.textContent = 'Unknown'
      typeEl.className = ''
      amountEl.textContent = amountStr
      amountEl.className = ''
    }

    // Set fee
    feeEl.textContent = feeStr

    // Set address with label
    if (details.address) {
      addressEl.textContent = details.address
    } else {
      addressEl.textContent = 'Not available'
    }

    // Set TX key (proof of payment)
    if (details.txKey) {
      keyEl.textContent = details.txKey
    } else {
      keyEl.textContent = 'Not available (only for outgoing)'
    }

    // Set confirmations
    const confirmations = details.confirmations || 0
    if (confirmations >= 10) {
      confEl.textContent = `${confirmations} (Confirmed)`
    } else if (confirmations > 0) {
      confEl.textContent = `${confirmations} (Pending)`
    } else {
      confEl.textContent = 'Pending'
    }

    // Check if this transaction can be linked to a post
    let linkedPost = null

    // For incoming: look up by subaddress index (tips you received)
    if (details.isIncoming && details.subaddressIndices && details.subaddressIndices.length > 0) {
      for (const subaddrIndex of details.subaddressIndices) {
        const postInfo = state.subaddressToPost.get(subaddrIndex)
        if (postInfo) {
          linkedPost = postInfo
          break
        }
      }
    }

    // For outgoing: check if this was a tip we sent
    if (details.isOutgoing && details.tippedPost) {
      linkedPost = details.tippedPost
    }

    if (linkedPost && postRow && viewPostLink) {
      // Show the "View Post" link
      postRow.classList.remove('hidden')

      // Remove any existing handler and add new one
      const newLink = viewPostLink.cloneNode(true)
      viewPostLink.parentNode.replaceChild(newLink, viewPostLink)

      newLink.addEventListener('click', async (e) => {
        e.preventDefault()
        e.stopPropagation()
        modal.classList.add('hidden')
        await pushPanel('thread', {
          pubkey: linkedPost.pubkey,
          timestamp: linkedPost.timestamp,
          focusReply: false
        })
      })
    }
  } catch (e) {
    console.error('Error loading transaction details:', e)
    typeEl.textContent = 'Error loading details'
    typeEl.className = ''
    amountEl.textContent = '-'
    feeEl.textContent = '-'
    addressEl.textContent = e.message || 'Error'
    keyEl.textContent = '-'
    confEl.textContent = '-'
  }
}

/**
 * Handle sync
 */
async function handleSync() {
  const btn = document.getElementById('syncWalletBtn')
  const progress = document.getElementById('syncProgress')
  const progressFill = document.getElementById('syncProgressFill')
  const progressText = document.getElementById('syncProgressText')

  // Don't start a new sync if one is already in progress
  const syncStatus = wallet.getSyncStatus()
  if (syncStatus.isSyncing) {
    btn.textContent = 'Syncing...'
    btn.disabled = true
    return
  }

  btn.disabled = true
  progress.classList.remove('hidden')
  progressText.textContent = 'Connecting to node...'

  // Smooth progress state
  let displayedPercent = 0
  let targetPercent = 0
  let lastReportedHeight = 0
  let lastReportedEndHeight = 0
  let animationFrameId = null

  // Animate progress bar smoothly between updates
  const animateProgress = () => {
    if (displayedPercent < targetPercent) {
      // Increment by small amounts for smooth animation (max 1% per frame)
      displayedPercent = Math.min(displayedPercent + 0.5, targetPercent)
      progressFill.style.width = `${displayedPercent}%`

      // Update text with interpolated block height
      if (lastReportedEndHeight > 0) {
        const interpolatedHeight = Math.floor(lastReportedHeight + (lastReportedEndHeight - lastReportedHeight) * (displayedPercent / 100))
        progressText.textContent = `Syncing... ${Math.floor(displayedPercent)}% (Block ${interpolatedHeight.toLocaleString()} / ${lastReportedEndHeight.toLocaleString()})`
      }
    }

    if (displayedPercent < 100) {
      animationFrameId = requestAnimationFrame(animateProgress)
    }
  }

  try {
    await wallet.sync((info) => {
      const percent = Math.round(info.percentDone * 100)
      targetPercent = percent
      lastReportedHeight = info.height || lastReportedHeight
      lastReportedEndHeight = info.endHeight || lastReportedEndHeight

      // Start animation if not already running
      if (!animationFrameId && displayedPercent < targetPercent) {
        animationFrameId = requestAnimationFrame(animateProgress)
      }

      // Immediately update if we jumped ahead significantly (first callback or big jump)
      if (targetPercent - displayedPercent > 10) {
        displayedPercent = targetPercent - 5 // Catch up quickly but still animate the last bit
      }
    })

    // Stop animation
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
    }

    // Ensure we show 100%
    progressFill.style.width = '100%'
    progressText.textContent = 'Sync complete!'
    setTimeout(async () => {
      progress.classList.add('hidden')
      await renderWalletPanel()
    }, 1000)
  } catch (e) {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
    }
    progressText.textContent = 'Sync failed: ' + e.message
    setTimeout(() => { progress.classList.add('hidden') }, 3000)
  }

  btn.disabled = false
}

/**
 * Handle preview send
 */
async function handlePreviewSend() {
  const addressInput = document.getElementById('sendAddress')
  const amountInput = document.getElementById('sendAmount')
  const btn = document.getElementById('previewSendBtn')

  const address = addressInput.value.trim()
  const amountStr = amountInput.value.trim()

  if (!address) {
    alert('Please enter a recipient address')
    return
  }

  if (!amountStr) {
    alert('Please enter an amount')
    return
  }

  btn.disabled = true

  try {
    const amount = wallet.parseXMR(amountStr)
    const { fee } = await wallet.createTransaction(address, amount)

    const total = amount + fee
    const amountNum = Number(amount) / 1e12
    const feeNum = Number(fee) / 1e12
    const totalNum = Number(total) / 1e12

    let amountDisplay = `${amountNum.toFixed(8)} XMR`
    let feeDisplay = `${feeNum.toFixed(8)} XMR`
    let totalDisplay = `${totalNum.toFixed(8)} XMR`

    if (xmrPrice) {
      amountDisplay += ` (~$${Math.abs(amountNum * xmrPrice).toFixed(2)})`
      feeDisplay += ` (~$${Math.abs(feeNum * xmrPrice).toFixed(2)})`
      totalDisplay += ` (~$${Math.abs(totalNum * xmrPrice).toFixed(2)})`
    }

    // Update preview modal
    document.getElementById('sendPreviewAmount').textContent = amountDisplay
    document.getElementById('sendPreviewFee').textContent = feeDisplay
    document.getElementById('sendPreviewTotal').textContent = totalDisplay
    document.getElementById('sendPreviewAddress').textContent = `${address.slice(0, 20)}...${address.slice(-8)}`

    document.getElementById('sendPreviewModal')?.classList.remove('hidden')
  } catch (e) {
    alert('Error: ' + e.message)
    wallet.cancelPendingTransaction()
  }

  btn.disabled = false
}

/**
 * Handle confirm send
 */
async function handleConfirmSend() {
  const btn = document.getElementById('sendPreviewConfirm')
  btn.disabled = true

  try {
    const { txHash } = await wallet.relayTransaction()

    // Immediately refresh wallet tx history so it appears in UI
    await wallet.refreshAfterSend()

    alert('Transaction sent!\n\nTX Hash: ' + txHash)

    // Clear form
    document.getElementById('sendAddress').value = ''
    document.getElementById('sendAmount').value = ''
    document.getElementById('sendPreviewModal')?.classList.add('hidden')

    await renderWalletPanel()
  } catch (e) {
    alert('Error sending transaction: ' + e.message)
  }

  btn.disabled = false
}

/**
 * Handle delete wallet (from unlocked state)
 */
function handleDeleteWallet() {
  showDeleteWalletModal()
}

/**
 * Handle create wallet
 */
async function handleCreateWallet() {
  const passwordInput = document.getElementById('createWalletPassword')
  const confirmInput = document.getElementById('createWalletConfirm')
  const btn = document.getElementById('createWalletSubmit')

  const password = passwordInput.value
  const confirm = confirmInput.value

  if (!password) {
    alert('Please enter a password')
    return
  }

  if (password !== confirm) {
    alert('Passwords do not match')
    return
  }

  btn.disabled = true

  try {
    const { seed, address } = await wallet.createWallet(state.activeAccountName, password)

    passwordInput.value = ''
    confirmInput.value = ''
    document.getElementById('createWalletModal')?.classList.add('hidden')

    // Auto-update profile with wallet address so peers can tip us
    await updateProfileWithNewSubaddress()

    alert('Wallet created!\n\nIMPORTANT: Write down your seed phrase and keep it safe!\n\n' + seed)

    await renderWalletPanel()
  } catch (e) {
    alert('Error creating wallet: ' + e.message)
  }

  btn.disabled = false
}

/**
 * Handle restore wallet
 */
async function handleRestoreWallet() {
  const seedInput = document.getElementById('restoreSeed')
  const heightInput = document.getElementById('restoreHeight')
  const passwordInput = document.getElementById('restoreWalletPassword')
  const confirmInput = document.getElementById('restoreWalletConfirm')
  const btn = document.getElementById('restoreWalletSubmit')

  const seed = seedInput.value.trim()
  const heightStr = heightInput.value.trim()
  const password = passwordInput.value
  const confirm = confirmInput.value

  if (!seed) {
    alert('Please enter your seed phrase')
    return
  }

  if (!heightStr) {
    alert('Please enter a restore height.\n\nThis is the block number when your wallet was created. If you don\'t know it, check your original wallet backup or estimate based on when you created it.')
    return
  }

  const restoreHeight = parseInt(heightStr, 10)
  if (isNaN(restoreHeight) || restoreHeight < 0) {
    alert('Restore height must be a valid non-negative number')
    return
  }

  if (!password) {
    alert('Please enter a password')
    return
  }

  if (password !== confirm) {
    alert('Passwords do not match')
    return
  }

  btn.disabled = true
  btn.textContent = 'Restoring...'

  try {
    await wallet.restoreWallet(state.activeAccountName, seed, password, restoreHeight)

    seedInput.value = ''
    heightInput.value = ''
    passwordInput.value = ''
    confirmInput.value = ''
    document.getElementById('restoreWalletModal')?.classList.add('hidden')

    // Auto-update profile with wallet address so peers can tip us
    await updateProfileWithNewSubaddress()

    // Auto-start sync with progress display (no popup)
    await renderUnlockedStateWithSync(state.activeAccountName)
  } catch (e) {
    alert('Error restoring wallet: ' + e.message)
  }

  btn.disabled = false
  btn.textContent = 'Restore'
}

/**
 * Handle unlock
 */
async function handleUnlock() {
  const passwordInput = document.getElementById('unlockWalletPassword')
  const btn = document.getElementById('unlockWalletSubmit')

  const password = passwordInput.value

  if (!password) {
    alert('Please enter your password')
    return
  }

  btn.disabled = true
  btn.textContent = 'Unlocking...'

  try {
    await wallet.unlock(state.activeAccountName, password)

    // Update profile with a fresh subaddress for improved privacy
    await updateProfileWithNewSubaddress()

    passwordInput.value = ''
    document.getElementById('unlockWalletModal')?.classList.add('hidden')

    // Show privacy notice (once per session)
    showPrivacyNotice()

    // Nudge the scheduler so any paywalled posts queued while the wallet
    // was locked get a chance to fire immediately instead of waiting for
    // the next periodic tick.
    if (state.scheduler) {
      state.scheduler.tick().catch(() => {})
    }

    // Render panel with sync progress
    await renderUnlockedStateWithSync(state.activeAccountName)
  } catch (e) {
    alert('Invalid password')
    btn.textContent = 'Unlock'
  }

  btn.disabled = false
  btn.textContent = 'Unlock'
}

/**
 * Render unlocked state with auto-sync
 */
async function renderUnlockedStateWithSync(accountName) {
  const meta = await wallet.getWalletMeta(accountName)
  const address = meta?.primaryAddress
  const shortAddress = address ? `${address.slice(0, 16)}...${address.slice(-8)}` : ''
  const restoreHeight = meta?.restoreHeight || 0
  const lastSynced = meta?.lastSyncedHeight

  // Check if a sync is already in progress (e.g., from background sync)
  const syncStatus = wallet.getSyncStatus()
  const syncAlreadyRunning = syncStatus.isSyncing

  // Show syncing UI immediately
  dom.walletContent.innerHTML = `
    <div class="wallet-unlocked">
      <div class="wallet-balance">
        <span class="label">Balance:</span>
        <span class="value">Syncing...</span>
      </div>

      <div id="syncNodeStatus" class="wallet-node-info">
        <span class="label">Node:</span>
        <span class="value node-value" id="syncNodeValue">Connecting...</span>
      </div>

      <div id="syncProgress" class="sync-progress">
        <div class="progress-bar"><div class="progress-fill" id="syncProgressFill"></div></div>
        <span id="syncProgressText">Connecting to node...</span>
      </div>

      <div class="wallet-sync-info">
        <span class="label">Restore height: ${restoreHeight.toLocaleString()}${lastSynced ? ` | Last synced: ${lastSynced.toLocaleString()}` : ''}</span>
      </div>

      <div class="wallet-section">
        <h4>Receive</h4>
        <div class="wallet-receive">
          <code>${escapeHtml(shortAddress)}</code>
        </div>
      </div>

      <div class="wallet-toolbar">
        <button id="lockWalletBtn" class="btn small">Lock</button>
      </div>
    </div>
  `

  document.getElementById('lockWalletBtn')?.addEventListener('click', async () => {
    await wallet.lock()
    await renderWalletPanel()
  })

  const progressFill = document.getElementById('syncProgressFill')
  const progressText = document.getElementById('syncProgressText')
  const nodeValue = document.getElementById('syncNodeValue')

  // Smooth progress animation state
  let displayedPercent = 0
  let targetPercent = 0
  let lastReportedHeight = 0
  let lastReportedEndHeight = 0
  let animationFrameId = null

  // Animate progress bar smoothly between updates
  const animateProgress = () => {
    if (displayedPercent < targetPercent) {
      // Increment by small amounts for smooth animation (max 1% per frame)
      displayedPercent = Math.min(displayedPercent + 0.5, targetPercent)
      progressFill.style.width = `${displayedPercent}%`

      // Update text with interpolated block height for smoother display
      if (lastReportedEndHeight > 0 && lastReportedHeight > 0) {
        const totalBlocks = lastReportedEndHeight - (lastReportedEndHeight - lastReportedHeight) / (targetPercent / 100 || 1)
        const interpolatedHeight = Math.floor(totalBlocks + (lastReportedEndHeight - totalBlocks) * (displayedPercent / 100))
        progressText.textContent = `Syncing... ${Math.floor(displayedPercent)}% (Block ${interpolatedHeight.toLocaleString()} / ${lastReportedEndHeight.toLocaleString()})`
      }
    }

    if (displayedPercent < 100) {
      animationFrameId = requestAnimationFrame(animateProgress)
    }
  }

  // Start animation loop
  const startAnimation = () => {
    if (!animationFrameId && displayedPercent < targetPercent) {
      animationFrameId = requestAnimationFrame(animateProgress)
    }
  }

  // Stop animation loop
  const stopAnimation = () => {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
  }

  // Helper to update progress UI with smooth animation
  const updateProgressUI = (progress) => {
    const percent = Math.round(progress.percentDone * 100)
    targetPercent = percent
    lastReportedHeight = progress.height || lastReportedHeight
    lastReportedEndHeight = progress.endHeight || lastReportedEndHeight

    // Start animation if not already running
    startAnimation()

    // Catch up quickly if we're way behind (first callback or big jump)
    if (targetPercent - displayedPercent > 10) {
      displayedPercent = targetPercent - 5
    }

    // Update node status
    if (progress.isConnected && progress.nodeUrl) {
      try {
        const url = new URL(progress.nodeUrl)
        nodeValue.textContent = url.hostname
        nodeValue.classList.add('connected')
      } catch {
        nodeValue.textContent = progress.nodeUrl
      }
    } else if (progress.isConnected) {
      nodeValue.textContent = 'Connected'
      nodeValue.classList.add('connected')
    }
  }

  if (syncAlreadyRunning) {
    // Background sync is already running - poll for progress
    console.log('[Wallet UI] Monitoring existing background sync')

    // Update with current progress
    if (syncStatus.progress.isConnected) {
      updateProgressUI(syncStatus.progress)
    }

    // Poll for progress updates
    const pollInterval = setInterval(() => {
      const status = wallet.getSyncStatus()

      if (!status.isSyncing) {
        // Sync completed
        clearInterval(pollInterval)
        stopAnimation()
        progressFill.style.width = '100%'
        progressText.textContent = 'Sync complete!'

        // Re-render with full UI
        setTimeout(async () => {
          await renderUnlockedState(accountName)
        }, 500)
        return
      }

      updateProgressUI(status.progress)
    }, 100) // Poll more frequently for smoother updates

    // Clean up interval if wallet is locked
    const checkLocked = setInterval(() => {
      if (!wallet.isWalletUnlocked()) {
        clearInterval(pollInterval)
        clearInterval(checkLocked)
        stopAnimation()
      }
    }, 1000)

  } else {
    // Start our own sync with progress callback
    try {
      await wallet.sync((info) => {
        updateProgressUI({
          height: info.height,
          endHeight: info.endHeight,
          percentDone: info.percentDone,
          isConnected: true,
          nodeUrl: wallet.getSelectedNode()?.url
        })
      })

      stopAnimation()
      progressFill.style.width = '100%'
      progressText.textContent = 'Sync complete!'

      // Start background sync now that initial sync is done
      wallet.startBackgroundSync()

      // Re-render with full UI after sync
      setTimeout(async () => {
        await renderUnlockedState(accountName)
      }, 500)
    } catch (e) {
      stopAnimation()
      progressText.textContent = 'Sync failed: ' + e.message
      nodeValue.textContent = 'Connection failed'
      nodeValue.classList.remove('connected')
      nodeValue.classList.add('error')

      // Start background sync anyway to retry later
      wallet.startBackgroundSync()

      // Still render full UI, but balance won't be available
      setTimeout(async () => {
        await renderUnlockedState(accountName)
      }, 2000)
    }
  }
}

/**
 * Show create wallet modal
 */
export function showCreateWalletModal() {
  const modal = document.getElementById('createWalletModal')
  if (modal) {
    modal.classList.remove('hidden')
    document.getElementById('createWalletPassword')?.focus()
  }
}

/**
 * Show restore wallet modal
 */
export function showRestoreWalletModal() {
  const modal = document.getElementById('restoreWalletModal')
  if (modal) {
    modal.classList.remove('hidden')
    document.getElementById('restoreSeed')?.focus()
  }
}

/**
 * Show unlock modal
 */
export function showUnlockModal() {
  const modal = document.getElementById('unlockWalletModal')
  if (modal) {
    modal.classList.remove('hidden')
    document.getElementById('unlockWalletPassword')?.focus()
  }
}
