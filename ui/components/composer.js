/**
 * Post composer component - expanded composer in center column
 */

import { state, dom } from '../state.js'
import { wrapSelection, insertAtCursor } from '../utils/dom.js'
import { initEmojiPicker, toggleEmojiPicker } from '../utils/emoji.js'
import { createPostEvent } from '../../lib/events.js'
import * as wallet from '../../lib/wallet.js'
import { extractHashtags } from '../../lib/tag-extractor.js'
import { createPaywalledPost, persistContentKey, cacheUnlockedContent } from '../../lib/paywall.js'
import { pushPanel } from './panel.js'
import { schedulePublicSiteRebuild } from '../../app.js'

// Expanded composer pending media/files
let expPendingMedia = []
let expPendingFiles = []

// Sync check interval for composer
let syncCheckInterval = null

/**
 * Show the expanded composer
 */
export function showExpandedComposer() {
  dom.expandedComposer.classList.remove('hidden')
  dom.postsEl.classList.add('hidden')

  // Show wallet hint if wallet is locked
  const walletHint = document.getElementById('walletHint')
  const walletSyncHint = document.getElementById('walletSyncHint')
  if (walletHint) {
    if (wallet.isWalletUnlocked()) {
      walletHint.classList.add('hidden')
    } else {
      walletHint.classList.remove('hidden')
    }
  }

  // Start monitoring sync state while composer is open
  updateSyncHint()
  syncCheckInterval = setInterval(updateSyncHint, 2000)

  dom.expPostContent.focus()
}

/**
 * Hide the expanded composer and return to timeline
 */
export function hideExpandedComposer() {
  dom.expandedComposer.classList.add('hidden')
  dom.postsEl.classList.remove('hidden')
  if (syncCheckInterval) {
    clearInterval(syncCheckInterval)
    syncCheckInterval = null
  }
}

/**
 * Clear expanded composer content
 */
function clearExpandedComposer() {
  dom.expPostContent.value = ''
  dom.expCharCount.textContent = '0'
  dom.expMediaPreview.innerHTML = ''
  expPendingMedia = []
  expPendingFiles = []
  dom.expPostBtn.disabled = true

  // Reset paywall fields
  const toggle = document.getElementById('expPaywallToggle')
  const fields = document.getElementById('expPaywallFields')
  const priceInput = document.getElementById('expPaywallPrice')
  const previewInput = document.getElementById('expPaywallPreview')
  if (toggle) toggle.checked = false
  if (fields) fields.classList.add('hidden')
  if (priceInput) priceInput.value = ''
  if (previewInput) previewInput.value = ''
}

/**
 * Update tag hint based on hashtags in content
 */
function updateTagHint() {
  const content = dom.expPostContent.value
  const tags = extractHashtags(content)
  const hintEl = document.getElementById('expTagHint')
  if (!hintEl) return

  if (tags.length > 0) {
    const tagList = tags.slice(0, 5).map(t => '#' + t).join(', ')
    const moreCount = tags.length > 5 ? ` +${tags.length - 5} more` : ''
    hintEl.innerHTML = `
      <span class="tag-hint-discoverable">Discoverable via search: ${tagList}${moreCount}</span>
    `
  } else {
    hintEl.innerHTML = `
      <span class="tag-hint-private">Only visible to your followers</span>
      <span class="tag-hint-tip">Add #hashtags to make your post discoverable via search</span>
    `
  }
}

/**
 * Update character count for expanded composer
 */
function updateExpCharCount() {
  dom.expCharCount.textContent = dom.expPostContent.value.length
  dom.expPostBtn.disabled = dom.expPostContent.value.trim().length === 0 &&
    expPendingMedia.length === 0 && expPendingFiles.length === 0
  updateTagHint()
}

/**
 * Add media preview for expanded composer
 */
function addExpMediaPreview(file) {
  const div = document.createElement('div')
  div.className = 'media-preview-item'

  if (file.type.startsWith('video/')) {
    div.innerHTML = `
      <div class="video-preview-icon">&#127909;</div>
      <span class="file-preview-name">${file.name.slice(0, 20)}${file.name.length > 20 ? '...' : ''}</span>
      <button class="remove-media" type="button">&times;</button>
    `
    div.querySelector('.remove-media').addEventListener('click', () => {
      const index = expPendingMedia.indexOf(file)
      if (index > -1) expPendingMedia.splice(index, 1)
      div.remove()
      updateExpCharCount()
    })
    dom.expMediaPreview.appendChild(div)
  } else {
    const reader = new FileReader()
    reader.onload = (e) => {
      div.innerHTML = `
        <img src="${e.target.result}" alt="preview">
        <button class="remove-media" type="button">&times;</button>
      `
      div.querySelector('.remove-media').addEventListener('click', () => {
        const index = expPendingMedia.indexOf(file)
        if (index > -1) expPendingMedia.splice(index, 1)
        div.remove()
        updateExpCharCount()
      })
      dom.expMediaPreview.appendChild(div)
    }
    reader.readAsDataURL(file)
  }
}

/**
 * Add file preview for expanded composer
 */
function addExpFilePreview(file) {
  const div = document.createElement('div')
  div.className = 'media-preview-item file-preview'
  div.innerHTML = `
    <div class="file-preview-icon">&#128206;</div>
    <span class="file-preview-name">${file.name.slice(0, 20)}${file.name.length > 20 ? '...' : ''}</span>
    <button class="remove-media" type="button">&times;</button>
  `
  div.querySelector('.remove-media').addEventListener('click', () => {
    const index = expPendingFiles.indexOf(file)
    if (index > -1) expPendingFiles.splice(index, 1)
    div.remove()
    updateExpCharCount()
  })
  dom.expMediaPreview.appendChild(div)
}

/**
 * Update sync hint visibility and post button state
 */
function updateSyncHint() {
  const syncHint = document.getElementById('walletSyncHint')
  const progressEl = document.getElementById('syncHintProgress')
  if (!syncHint) return

  const unlocked = wallet.isWalletUnlocked()
  const syncing = unlocked && wallet.getSyncStatus().isSyncing

  if (syncing) {
    syncHint.classList.remove('hidden')
    const progress = wallet.getSyncStatus().progress
    if (progressEl && progress?.percentDone != null) {
      progressEl.textContent = ` (${Math.round(progress.percentDone)}%)`
    }
    dom.expPostBtn.disabled = true
  } else {
    syncHint.classList.add('hidden')
    if (progressEl) progressEl.textContent = ''
    // Re-enable post button based on content (defer to normal check)
    updateExpCharCount()
  }
}

/**
 * Create post from expanded composer
 */
async function createExpandedPost(refreshUI) {
  const content = dom.expPostContent.value.trim()
  if (!content && expPendingMedia.length === 0 && expPendingFiles.length === 0) return

  // Check paywall toggle
  const paywallToggle = document.getElementById('expPaywallToggle')
  const isPaywalled = paywallToggle?.checked

  if (isPaywalled) {
    if (!wallet.isWalletUnlocked()) {
      alert('Your wallet must be unlocked to create a paywalled post.')
      return
    }
    const priceInput = document.getElementById('expPaywallPrice')
    const previewInput = document.getElementById('expPaywallPreview')
    const price = priceInput?.value?.trim()
    const preview = previewInput?.value?.trim()
    if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
      alert('Please enter a valid XMR price for the paywall.')
      return
    }
    if (!preview) {
      alert('Please enter a public preview text for the paywall.')
      return
    }
  }

  dom.expPostBtn.disabled = true
  try {
    // Upload pending media
    const uploadedMedia = []
    if (state.media && expPendingMedia.length > 0) {
      for (const file of expPendingMedia) {
        let result
        if (file.type.startsWith('video/')) {
          result = await state.media.storeVideo(file, file.name)
        } else {
          result = await state.media.storeImage(file, file.name)
        }
        uploadedMedia.push(result)
      }
    }

    // Upload pending files
    if (state.media && expPendingFiles.length > 0) {
      for (const file of expPendingFiles) {
        const result = await state.media.storeFile(file, file.name)
        uploadedMedia.push(result)
      }
    }

    if (isPaywalled) {
      // Encrypt the post body and prepare paywall fields
      const priceInput = document.getElementById('expPaywallPrice')
      const previewInput = document.getElementById('expPaywallPreview')
      const paywallFields = await createPaywalledPost({
        content,
        media: uploadedMedia,
        priceXmr: priceInput.value.trim(),
        preview: previewInput.value.trim()
      })

      // For paywalled posts: store empty content + media in the public event
      // (the real content is in paywall_encrypted)
      const appended = await state.feed.append(createPostEvent({
        content: '',
        media: undefined,
        paywallPrice: paywallFields.paywallPrice,
        paywallPreview: paywallFields.paywallPreview,
        paywallEncrypted: paywallFields.paywallEncrypted,
        paywallSubaddress: paywallFields.paywallSubaddress,
        paywallSubaddressIndex: paywallFields.paywallSubaddressIndex
      }))

      // Persist the content key under the actual timestamp assigned by feed.append
      // Also cache the decrypted content so the author sees it normally in their own feed
      if (appended && appended.timestamp) {
        persistContentKey(appended.timestamp, paywallFields.contentKeyHex)
        cacheUnlockedContent(appended.pubkey, appended.timestamp, content, uploadedMedia)
      }
    } else {
      // Regular post path
      // Generate subaddress for tips if wallet is unlocked
      let subaddress = null
      let subaddress_index = null
      if (wallet.isWalletUnlocked()) {
        try {
          const addr = await wallet.getReceiveAddress(true)
          subaddress = addr.address
          subaddress_index = addr.index
        } catch (err) {
          console.warn('Failed to create subaddress:', err)
        }
      }

      // Create and append post
      await state.feed.append(createPostEvent({
        content,
        media: uploadedMedia.length > 0 ? uploadedMedia : undefined,
        subaddress,
        subaddressIndex: subaddress_index
      }))
    }

    schedulePublicSiteRebuild()

    clearExpandedComposer()
    hideExpandedComposer()
    await refreshUI()
  } catch (err) {
    alert('Error creating post: ' + err.message)
  }
  dom.expPostBtn.disabled = false
}

/**
 * Initialize composer - sets up the expanded composer in center column
 */
export function initComposer(refreshUI) {
  // Create Post button opens expanded composer
  dom.createPostBtn.addEventListener('click', () => {
    showExpandedComposer()
  })

  // Wallet hint link - opens wallet panel
  const walletHintLink = document.getElementById('walletHintLink')
  if (walletHintLink) {
    walletHintLink.addEventListener('click', (e) => {
      e.preventDefault()
      hideExpandedComposer()
      pushPanel('wallet')
    })
  }

  // Close/cancel buttons
  dom.closeExpandedComposer.addEventListener('click', () => {
    hideExpandedComposer()
    clearExpandedComposer()
  })

  dom.cancelExpandedPost.addEventListener('click', () => {
    hideExpandedComposer()
    clearExpandedComposer()
  })

  // Initialize emoji picker for expanded composer
  initEmojiPicker(dom.expEmojiGrid, dom.expEmojiPicker, dom.expPostContent, updateExpCharCount)

  // Toolbar buttons
  dom.expBoldBtn.addEventListener('click', () => wrapSelection(dom.expPostContent, '**', '**', updateExpCharCount))
  dom.expItalicBtn.addEventListener('click', () => wrapSelection(dom.expPostContent, '*', '*', updateExpCharCount))
  dom.expCodeBtn.addEventListener('click', () => wrapSelection(dom.expPostContent, '`', '`', updateExpCharCount))

  // Link button - inline form elements
  const expLinkForm = document.getElementById('expLinkForm')
  const expLinkText = document.getElementById('expLinkText')
  const expLinkUrl = document.getElementById('expLinkUrl')
  const expLinkCancel = document.getElementById('expLinkCancel')
  const expLinkInsert = document.getElementById('expLinkInsert')
  let linkSelectionStart = 0
  let linkSelectionEnd = 0
  let linkSelectedText = ''

  dom.expLinkBtn.addEventListener('click', () => {
    const start = dom.expPostContent.selectionStart
    const end = dom.expPostContent.selectionEnd
    const selectedText = dom.expPostContent.value.substring(start, end)

    if (selectedText) {
      if (/\.\w{2,}/.test(selectedText) && !selectedText.startsWith('http') && !selectedText.includes(' ')) {
        // Looks like a domain - add https://
        const beforeText = dom.expPostContent.value.substring(0, start)
        const afterText = dom.expPostContent.value.substring(end)
        dom.expPostContent.value = beforeText + `https://${selectedText}` + afterText
        dom.expPostContent.selectionStart = start
        dom.expPostContent.selectionEnd = start + selectedText.length + 8
        dom.expPostContent.focus()
      } else if (!selectedText.startsWith('http')) {
        // Show inline link form
        linkSelectionStart = start
        linkSelectionEnd = end
        linkSelectedText = selectedText
        expLinkText.textContent = selectedText.length > 30 ? selectedText.slice(0, 30) + '...' : selectedText
        expLinkUrl.value = ''
        expLinkForm.classList.remove('hidden')
        expLinkUrl.focus()
      }
    } else {
      insertAtCursor(dom.expPostContent, 'https://')
      dom.expPostContent.focus()
    }
    updateExpCharCount()
  })

  expLinkCancel.addEventListener('click', () => {
    expLinkForm.classList.add('hidden')
    dom.expPostContent.focus()
  })

  expLinkInsert.addEventListener('click', () => {
    let url = expLinkUrl.value.trim()
    if (url) {
      // Auto-add https:// if not present
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url
      }
      const beforeText = dom.expPostContent.value.substring(0, linkSelectionStart)
      const afterText = dom.expPostContent.value.substring(linkSelectionEnd)
      dom.expPostContent.value = beforeText + `[${linkSelectedText}](${url})` + afterText
      updateExpCharCount()
    }
    expLinkForm.classList.add('hidden')
    dom.expPostContent.focus()
  })

  expLinkUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      expLinkInsert.click()
    } else if (e.key === 'Escape') {
      expLinkCancel.click()
    }
  })

  // Emoji picker
  dom.expEmojiBtn.addEventListener('click', (e) => toggleEmojiPicker(dom.expEmojiPicker, e))

  // Media button
  dom.expMediaBtn.addEventListener('click', () => {
    dom.expMediaInput.click()
  })

  // Handle media selection
  dom.expMediaInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        expPendingMedia.push(file)
        addExpMediaPreview(file)
      }
    }
    dom.expMediaInput.value = ''
    updateExpCharCount()
  })

  // File button
  dom.expFileBtn.addEventListener('click', () => {
    dom.expFileInput.click()
  })

  // Handle file selection
  dom.expFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    for (const file of files) {
      expPendingFiles.push(file)
      addExpFilePreview(file)
    }
    dom.expFileInput.value = ''
    updateExpCharCount()
  })

  // Character count
  dom.expPostContent.addEventListener('input', updateExpCharCount)

  // Paywall toggle - show/hide paywall fields
  const paywallToggle = document.getElementById('expPaywallToggle')
  const paywallFields = document.getElementById('expPaywallFields')
  if (paywallToggle && paywallFields) {
    paywallToggle.addEventListener('change', () => {
      if (paywallToggle.checked) {
        paywallFields.classList.remove('hidden')
        if (!wallet.isWalletUnlocked()) {
          alert('Heads up: your wallet is locked. You will need to unlock it before posting a paywalled post.')
        }
      } else {
        paywallFields.classList.add('hidden')
      }
    })
  }

  // Post button
  dom.expPostBtn.addEventListener('click', () => createExpandedPost(refreshUI))

  // Ctrl+Enter to post, Escape to cancel
  dom.expPostContent.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      dom.expPostBtn.click()
    }
    if (e.key === 'Escape') {
      hideExpandedComposer()
      clearExpandedComposer()
    }
  })
}
