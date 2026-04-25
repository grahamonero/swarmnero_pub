/**
 * Accounts component - account switcher dropdown and management
 */

import { state, dom } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { showSection, hideAllSections } from './panel.js'

// Callback for when account switch completes
let onAccountSwitchCallback = null

/**
 * Set the callback for account switching
 */
export function setOnAccountSwitch(callback) {
  onAccountSwitchCallback = callback
}

/**
 * Get initial letter for account avatar
 */
function getAccountInitial(name) {
  return name.charAt(0).toUpperCase()
}

/**
 * Render the account dropdown in the header
 */
export function renderAccountDropdown() {
  if (!dom.accountDropdown) return

  const accounts = state.accounts || []
  const active = state.activeAccountName || 'default'
  // Use profile display name if available, otherwise account name
  const displayName = state.myProfile?.name || active

  dom.accountDropdown.innerHTML = `
    <div class="account-current" id="accountToggle">
      <span class="account-avatar">${getAccountInitial(displayName)}</span>
      <span class="account-name">${escapeHtml(displayName)}</span>
      <span class="dropdown-arrow">&#9660;</span>
    </div>
    <div class="account-menu hidden" id="accountMenu">
      ${accounts.map(acc => {
        // Use profile name for active account, account name for others
        const isActive = acc.name === active
        const itemDisplayName = isActive && state.myProfile?.name ? state.myProfile.name : acc.name
        return `
        <div class="account-item ${isActive ? 'active' : ''}"
             data-account="${escapeHtml(acc.name)}"
             data-encrypted="${acc.encrypted}">
          <span class="account-avatar">${getAccountInitial(itemDisplayName)}</span>
          <span class="account-name">${escapeHtml(itemDisplayName)}</span>
          ${acc.encrypted ? '<span class="lock-icon">&#128274;</span>' : ''}
        </div>
      `}).join('')}
      <div class="account-divider"></div>
      <div class="account-nav-item" data-view-route="search">
        <span class="nav-icon">🔎</span>Search
      </div>
      <div class="account-nav-item" data-view-route="trending">
        <span class="nav-icon">📈</span>Trending
      </div>
      <div class="account-nav-item" data-view-route="bookmarks">
        <span class="nav-icon">🔖</span>Bookmarks
      </div>
      <div class="account-nav-item" data-view-route="storage">
        <span class="nav-icon">💾</span>Storage
      </div>
      <div class="account-nav-item" data-view-route="settings">
        <span class="nav-icon">⚙</span>Settings
      </div>
      <div class="account-divider"></div>
      <div class="account-action" id="manageAccountsBtn">
        Manage Accounts
      </div>
      <div class="account-nav-item logout" id="accountMenuLogout">
        <span class="nav-icon">🚪</span>Logout
      </div>
    </div>
  `

  // Toggle menu
  const toggle = document.getElementById('accountToggle')
  const menu = document.getElementById('accountMenu')

  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    menu.classList.toggle('hidden')
  })

  // Close menu when clicking outside (use named function to avoid duplicates)
  const closeMenu = (e) => {
    // Only close if clicking outside the dropdown
    if (!dom.accountDropdown?.contains(e.target)) {
      menu.classList.add('hidden')
    }
  }
  // Remove any existing listener before adding (uses capture to match)
  document.removeEventListener('click', window._accountMenuCloseHandler)
  window._accountMenuCloseHandler = closeMenu
  document.addEventListener('click', closeMenu)

  // Account switch handlers
  dom.accountDropdown.querySelectorAll('.account-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation()
      menu.classList.add('hidden')

      const name = item.dataset.account
      const encrypted = item.dataset.encrypted === 'true'

      if (name === state.activeAccountName) return

      if (encrypted) {
        showPasswordModal(name)
      } else {
        try {
          await switchAccount(name)
          renderAccountDropdown()
          // Now reinitialize feed (this takes time but UI is already updated)
          await runAccountSwitchCallback()
        } catch (err) {
          alert('Error switching account: ' + err.message)
        }
      }
    })
  })

  // Manage accounts
  const manageBtn = document.getElementById('manageAccountsBtn')
  if (manageBtn) {
    manageBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.classList.add('hidden')
      showSection('accounts')
    })
  }

  // Secondary nav items (Profile, Search, Trending, Storage, Settings)
  dom.accountDropdown.querySelectorAll('.account-nav-item[data-view-route]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.classList.add('hidden')
      // Clear active state from primary topnav tabs, then show the section.
      document.querySelectorAll('.nav-btn.active').forEach(b => b.classList.remove('active'))
      showSection(item.dataset.viewRoute)
    })
  })

  // Logout routed through existing logout button handler
  const logoutItem = document.getElementById('accountMenuLogout')
  if (logoutItem) {
    logoutItem.addEventListener('click', (e) => {
      e.stopPropagation()
      menu.classList.add('hidden')
      document.getElementById('logoutBtn')?.click()
    })
  }
}

/**
 * Switch to a different account (just updates identity, callback handles feed)
 */
async function switchAccount(name, password = null) {
  // First, just switch the account (verify password)
  await state.accountManager.switchAccount(name, password)

  // Update state immediately
  state.accounts = state.accountManager.accounts
  state.activeAccountName = state.accountManager.activeAccount

  // Clear cached data
  state.peerProfiles = {}
  state.swarmIdToPubkey = {}
  state.currentTimeline = []
  state.myProfile = null
}

/**
 * Run the account switch callback (reinitialize feed)
 * Call this AFTER closing modals
 */
export async function runAccountSwitchCallback() {
  if (onAccountSwitchCallback) {
    try {
      await onAccountSwitchCallback()
    } catch (err) {
      console.error('Error reinitializing feed:', err)
    }
  }
}

/**
 * Show password modal for encrypted account
 */
function showPasswordModal(accountName) {
  if (!dom.loginModal) return

  dom.loginModal.classList.remove('hidden')
  dom.loginModal.dataset.account = accountName
  dom.passwordInput.value = ''
  dom.passwordInput.focus()
}

/**
 * Render the accounts management panel
 */
export function renderAccountsPanel() {
  if (!dom.accountsPanelContent) return

  const accounts = state.accounts || []

  dom.accountsPanelContent.innerHTML = `
    <div class="accounts-list">
      ${accounts.map(acc => `
        <div class="account-row" data-account="${escapeHtml(acc.name)}">
          <div class="account-row-info">
            <span class="account-avatar">${getAccountInitial(acc.name)}</span>
            <div class="account-row-details">
              <span class="account-row-name">${escapeHtml(acc.name)}</span>
              <code class="account-row-id">${acc.pubkeyHex.slice(0, 16)}...</code>
            </div>
            ${acc.encrypted ? '<span class="lock-icon">&#128274;</span>' : ''}
          </div>
          ${acc.name !== state.activeAccountName ? `
            <button class="delete-account-btn" data-account="${escapeHtml(acc.name)}" data-encrypted="${acc.encrypted}">Delete</button>
          ` : '<span class="active-badge">Active</span>'}
        </div>
      `).join('')}
    </div>

    <h4 class="panel-subtitle">Create New Account</h4>
    <div class="form-group">
      <label for="newAccountName">Account Name</label>
      <input type="text" id="newAccountName" placeholder="e.g. work, anon">
    </div>
    <div class="form-group">
      <label for="newAccountPassword">Password (optional)</label>
      <input type="password" id="newAccountPassword" placeholder="Leave blank for no encryption">
    </div>
    <button id="createAccountBtn">Create Account</button>

    <h4 class="panel-subtitle">Export Keys</h4>
    <div class="export-section">
      <button id="exportSwarmIdBtn" class="secondary-btn">Copy Swarm ID</button>
      <button id="exportSecretKeyBtn" class="danger-btn">Export Secret Key</button>
    </div>
  `

  // Bind handlers
  bindAccountsPanelHandlers()
}

/**
 * Bind event handlers for accounts panel
 */
function bindAccountsPanelHandlers() {
  // Create account
  const createBtn = document.getElementById('createAccountBtn')
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const nameInput = document.getElementById('newAccountName')
      const passwordInput = document.getElementById('newAccountPassword')
      const name = nameInput.value.trim()
      const password = passwordInput.value || null

      if (!name) {
        alert('Please enter an account name')
        return
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        alert('Account name can only contain letters, numbers, underscores, and hyphens')
        return
      }

      createBtn.disabled = true
      try {
        await state.accountManager.createAccount(name, password)
        state.accounts = state.accountManager.accounts
        nameInput.value = ''
        passwordInput.value = ''
        renderAccountsPanel()
        renderAccountDropdown()
      } catch (err) {
        alert('Error creating account: ' + err.message)
      }
      createBtn.disabled = false
    })
  }

  // Delete account handlers
  document.querySelectorAll('.delete-account-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.account
      const encrypted = btn.dataset.encrypted === 'true'

      let password = null
      if (encrypted) {
        password = prompt('Enter password to delete this account:')
        if (password === null) return
      }

      if (!confirm(`Are you sure you want to delete the account "${name}"? This cannot be undone.`)) {
        return
      }

      btn.disabled = true
      try {
        await state.accountManager.deleteAccount(name, password)
        state.accounts = state.accountManager.accounts
        renderAccountsPanel()
        renderAccountDropdown()
      } catch (err) {
        alert('Error deleting account: ' + err.message)
        btn.disabled = false
      }
    })
  })

  // Export Swarm ID
  const exportSwarmIdBtn = document.getElementById('exportSwarmIdBtn')
  if (exportSwarmIdBtn) {
    exportSwarmIdBtn.addEventListener('click', async () => {
      try {
        const swarmId = state.feed?.swarmId
        if (!swarmId) {
          alert('Swarm ID not available')
          return
        }
        await navigator.clipboard.writeText(swarmId)
        exportSwarmIdBtn.textContent = 'Copied!'
        setTimeout(() => {
          exportSwarmIdBtn.textContent = 'Copy Swarm ID'
        }, 2000)
      } catch (err) {
        alert('Error copying Swarm ID: ' + err.message)
      }
    })
  }

  // Export Secret Key
  const exportSecretKeyBtn = document.getElementById('exportSecretKeyBtn')
  if (exportSecretKeyBtn) {
    exportSecretKeyBtn.addEventListener('click', () => {
      showExportWarningModal()
    })
  }
}

/**
 * Show export secret key warning modal
 */
function showExportWarningModal() {
  if (!dom.exportWarningModal) return

  const account = state.accountManager.getActiveAccount()
  const passwordGroup = document.getElementById('exportPasswordGroup')

  if (passwordGroup) {
    passwordGroup.style.display = account.encrypted ? 'block' : 'none'
  }

  dom.exportWarningModal.classList.remove('hidden')
  if (account.encrypted && dom.exportPasswordInput) {
    dom.exportPasswordInput.value = ''
    dom.exportPasswordInput.focus()
  }
}

/**
 * Initialize accounts component
 */
export function initAccounts() {
  // Password login modal handlers
  const loginSubmit = document.getElementById('loginSubmit')
  const loginCancel = document.getElementById('loginCancel')

  if (loginSubmit) {
    loginSubmit.addEventListener('click', async () => {
      const name = dom.loginModal.dataset.account
      const password = dom.passwordInput.value

      if (!password) {
        alert('Please enter a password')
        return
      }

      loginSubmit.disabled = true
      try {
        await switchAccount(name, password)
        dom.loginModal.classList.add('hidden')
        renderAccountDropdown()
        // Now reinitialize feed (modal is closed, user sees "Switching...")
        await runAccountSwitchCallback()
      } catch (err) {
        alert('Invalid password')
      }
      loginSubmit.disabled = false
    })
  }

  if (loginCancel) {
    loginCancel.addEventListener('click', () => {
      dom.loginModal.classList.add('hidden')
    })
  }

  // Export warning modal handlers
  const exportConfirm = document.getElementById('exportConfirm')
  const exportCancel = document.getElementById('exportCancel')

  if (exportConfirm) {
    exportConfirm.addEventListener('click', async () => {
      const account = state.accountManager.getActiveAccount()
      let password = null

      if (account.encrypted) {
        password = dom.exportPasswordInput?.value
        if (!password) {
          alert('Please enter your password')
          return
        }
      }

      exportConfirm.disabled = true
      try {
        const secretKey = await state.accountManager.exportSecretKey(state.activeAccountName, password)
        await navigator.clipboard.writeText(secretKey)
        alert('Secret Key copied to clipboard.\n\nWARNING: Keep this safe and never share it!')
        dom.exportWarningModal.classList.add('hidden')
      } catch (err) {
        alert('Error exporting Secret Key: ' + err.message)
      }
      exportConfirm.disabled = false
    })
  }

  if (exportCancel) {
    exportCancel.addEventListener('click', () => {
      dom.exportWarningModal.classList.add('hidden')
    })
  }

  // Enter key support for password inputs
  if (dom.passwordInput) {
    dom.passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        loginSubmit?.click()
      }
    })
  }

  if (dom.exportPasswordInput) {
    dom.exportPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        exportConfirm?.click()
      }
    })
  }
}
