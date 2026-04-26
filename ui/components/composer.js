/**
 * Post composer component - expanded composer in center column
 */

import { state, dom } from '../state.js'
import { wrapSelection, insertAtCursor } from '../utils/dom.js'
import { initEmojiPicker, toggleEmojiPicker } from '../utils/emoji.js'
import {
  createPostEvent,
  createPollEvent,
  createArticleEvent,
  MAX_MEDIA_PER_POST,
  MAX_CW_LENGTH,
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_LEN,
  ARTICLE_MAX_TITLE,
  ARTICLE_MAX_SUMMARY,
  ARTICLE_MAX_BODY
} from '../../lib/events.js'
import * as wallet from '../../lib/wallet.js'
import { extractHashtags } from '../../lib/tag-extractor.js'
import { createPaywalledPost, persistContentKey, cacheUnlockedContent } from '../../lib/paywall.js'
import { renderArticleMarkdown } from '../utils/markdown.js'
import { pushPanel } from './panel.js'
import { schedulePublicSiteRebuild } from '../../app.js'

// Article-mode pending cover image (single File). Uploaded at publish time.
let expPendingArticleCover = null

// Expanded composer pending media/files
let expPendingMedia = []
let expPendingFiles = []

// Sync check interval for composer
let syncCheckInterval = null

// The draft id currently bound to the composer UI. null when no autosave is
// active yet (e.g. composer was just opened with empty content).
let activeDraftId = null

// Debounce timer for autosaving composer state to the DraftStore.
let draftAutosaveTimer = null
const DRAFT_AUTOSAVE_DEBOUNCE_MS = 500

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

  renderSavedDraftsList()
  renderScheduledList()
  if (dom.expPostBtn) {
    dom.expPostBtn.textContent = dom.expScheduleToggle?.checked ? 'Schedule' : 'Post'
  }
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
  activeDraftId = null
  if (draftAutosaveTimer) {
    clearTimeout(draftAutosaveTimer)
    draftAutosaveTimer = null
  }

  // Reset paywall fields
  const toggle = document.getElementById('expPaywallToggle')
  const fields = document.getElementById('expPaywallFields')
  const priceInput = document.getElementById('expPaywallPrice')
  const previewInput = document.getElementById('expPaywallPreview')
  if (toggle) toggle.checked = false
  if (fields) fields.classList.add('hidden')
  if (priceInput) priceInput.value = ''
  if (previewInput) previewInput.value = ''

  // Reset CW fields
  const cwToggle = document.getElementById('expCwToggle')
  const cwFields = document.getElementById('expCwFields')
  const cwLabelInput = document.getElementById('expCwLabel')
  const cwCharCount = document.getElementById('expCwCharCount')
  if (cwToggle) cwToggle.checked = false
  if (cwFields) cwFields.classList.add('hidden')
  if (cwLabelInput) cwLabelInput.value = ''
  if (cwCharCount) cwCharCount.textContent = '0'

  if (dom.expScheduleToggle) dom.expScheduleToggle.checked = false
  if (dom.expScheduleFields) dom.expScheduleFields.classList.add('hidden')
  if (dom.expScheduleAt) dom.expScheduleAt.value = ''
  if (dom.expPostBtn) dom.expPostBtn.textContent = 'Post'

  // Reset poll fields
  const pollToggle = document.getElementById('expPollToggle')
  const pollFields = document.getElementById('expPollFields')
  const pollQuestion = document.getElementById('expPollQuestion')
  const pollDuration = document.getElementById('expPollDuration')
  if (pollToggle) pollToggle.checked = false
  if (pollFields) pollFields.classList.add('hidden')
  if (pollQuestion) pollQuestion.value = ''
  if (pollDuration) pollDuration.value = '86400000'
  resetPollOptions()

  // Reset article fields
  const articleToggle = document.getElementById('expArticleToggle')
  const articleFields = document.getElementById('expArticleFields')
  const articleTitle = document.getElementById('expArticleTitle')
  const articleSummary = document.getElementById('expArticleSummary')
  const articleTitleCount = document.getElementById('expArticleTitleCount')
  const articleSummaryCount = document.getElementById('expArticleSummaryCount')
  const articleCoverPreview = document.getElementById('expArticleCoverPreview')
  const articlePreview = document.getElementById('expArticlePreview')
  if (articleToggle) articleToggle.checked = false
  if (articleFields) articleFields.classList.add('hidden')
  if (articleTitle) articleTitle.value = ''
  if (articleSummary) articleSummary.value = ''
  if (articleTitleCount) articleTitleCount.textContent = '0'
  if (articleSummaryCount) articleSummaryCount.textContent = '0'
  if (articleCoverPreview) articleCoverPreview.innerHTML = ''
  if (articlePreview) {
    articlePreview.classList.add('hidden')
    articlePreview.innerHTML = ''
  }
  expPendingArticleCover = null
  if (dom.expandedComposer) dom.expandedComposer.classList.remove('article-mode')

  // Hide metadata warning (shown only when video/file is pending)
  document.getElementById('metadataWarningHint')?.classList.add('hidden')
}

/**
 * Autosave the composer state into the active account's DraftStore.
 * Debounced at the module level; the DraftStore applies a second
 * 500ms debounce on disk writes, so even a held-down key produces at
 * most ~2 writes/sec.
 */
function scheduleDraftAutosave() {
  if (!state.drafts) return
  if (draftAutosaveTimer) clearTimeout(draftAutosaveTimer)
  draftAutosaveTimer = setTimeout(() => {
    draftAutosaveTimer = null
    saveDraftNow({ fromAutosave: true })
  }, DRAFT_AUTOSAVE_DEBOUNCE_MS)
}

/**
 * Persist the current composer state as a draft. Returns the draft record
 * (or null if drafts aren't initialized). If the composer is empty and
 * this was triggered by autosave, skips writing.
 */
async function saveDraftNow({ fromAutosave = false } = {}) {
  if (!state.drafts) return null
  const content = dom.expPostContent.value
  const hasAttachments = expPendingMedia.length > 0 || expPendingFiles.length > 0
  const paywallToggle = document.getElementById('expPaywallToggle')
  const priceInput = document.getElementById('expPaywallPrice')
  const previewInput = document.getElementById('expPaywallPreview')
  const paywallEnabled = !!paywallToggle?.checked
  // Skip autosaves of totally empty composer state to avoid littering drafts.json
  if (fromAutosave && !content.trim() && !hasAttachments && !paywallEnabled) {
    return null
  }
  // Convert pending File objects to buffer-kind attachments so DraftStore
  // can copy them into the account dir. Already-stored ones keep their
  // relPath reference (not applicable yet — we reload into fresh File objects
  // on draft restore below).
  const media = []
  for (const f of expPendingMedia) {
    try {
      const bytes = Buffer.from(await f.arrayBuffer())
      media.push({ kind: 'buffer', bytes, name: f.name, mime: f.type || '' })
    } catch (err) {
      console.warn('[Composer] draft attachment read failed:', err.message)
    }
  }
  const files = []
  for (const f of expPendingFiles) {
    try {
      const bytes = Buffer.from(await f.arrayBuffer())
      files.push({ kind: 'buffer', bytes, name: f.name, mime: f.type || '' })
    } catch (err) {
      console.warn('[Composer] draft attachment read failed:', err.message)
    }
  }
  // Article-mode discriminator: when the toggle is on, persist title/summary
  // alongside the body so a draft round-trip restores the full article.
  const articleToggle = document.getElementById('expArticleToggle')
  const articleEnabled = !!articleToggle?.checked
  const articleTitle = (document.getElementById('expArticleTitle')?.value) || ''
  const articleSummary = (document.getElementById('expArticleSummary')?.value) || ''

  const draft = state.drafts.upsert({
    id: activeDraftId,
    content,
    media,
    files,
    paywall: {
      enabled: paywallEnabled,
      price: priceInput?.value || '',
      preview: previewInput?.value || ''
    },
    mode: articleEnabled ? 'article' : 'post',
    article: articleEnabled ? { title: articleTitle, summary: articleSummary } : null
  })
  activeDraftId = draft.id
  renderSavedDraftsList()
  return draft
}

/**
 * Load a draft into the composer (replaces current composer state).
 */
async function loadDraft(draftId) {
  if (!state.drafts) return
  const draft = state.drafts.get(draftId)
  if (!draft) return
  // Wipe current state first so we don't mix two drafts.
  activeDraftId = null
  clearExpandedComposer()
  activeDraftId = draft.id
  dom.expPostContent.value = draft.content || ''
  // Rehydrate attachment File objects from the encrypted store.
  for (const item of draft.media || []) {
    try {
      const bytes = state.drafts.readAttachmentBytes(item.relPath)
      const file = new File([bytes], item.name || 'attachment', { type: item.mime || '' })
      expPendingMedia.push(file)
      addExpMediaPreview(file)
    } catch (err) {
      console.warn('[Composer] draft media restore failed:', err.message)
    }
  }
  for (const item of draft.files || []) {
    try {
      const bytes = state.drafts.readAttachmentBytes(item.relPath)
      const file = new File([bytes], item.name || 'file', { type: item.mime || '' })
      expPendingFiles.push(file)
      addExpFilePreview(file)
    } catch (err) {
      console.warn('[Composer] draft file restore failed:', err.message)
    }
  }
  if (draft.paywall?.enabled) {
    const toggle = document.getElementById('expPaywallToggle')
    const fields = document.getElementById('expPaywallFields')
    const priceInput = document.getElementById('expPaywallPrice')
    const previewInput = document.getElementById('expPaywallPreview')
    if (toggle) toggle.checked = true
    if (fields) fields.classList.remove('hidden')
    if (priceInput) priceInput.value = draft.paywall.price || ''
    if (previewInput) previewInput.value = draft.paywall.preview || ''
  }
  // Phase 2A: restore article-mode draft fields. Note that the cover image is
  // NOT persisted in drafts (it's an attachment that must be re-selected on
  // restore — tracked as a follow-up).
  if (draft.mode === 'article' && draft.article) {
    const articleToggle = document.getElementById('expArticleToggle')
    const articleFields = document.getElementById('expArticleFields')
    const articleTitle = document.getElementById('expArticleTitle')
    const articleSummary = document.getElementById('expArticleSummary')
    const articleTitleCount = document.getElementById('expArticleTitleCount')
    const articleSummaryCount = document.getElementById('expArticleSummaryCount')
    if (articleToggle) articleToggle.checked = true
    if (articleFields) articleFields.classList.remove('hidden')
    if (articleTitle) articleTitle.value = draft.article.title || ''
    if (articleSummary) articleSummary.value = draft.article.summary || ''
    if (articleTitleCount) articleTitleCount.textContent = (draft.article.title || '').length
    if (articleSummaryCount) articleSummaryCount.textContent = (draft.article.summary || '').length
    if (dom.expandedComposer) dom.expandedComposer.classList.add('article-mode')
  }
  updateExpCharCount()
}

/**
 * Render the list of saved drafts above the footer.
 */
function renderSavedDraftsList() {
  const el = dom.draftsModalList
  if (!el || !state.drafts) return
  const list = state.drafts.list().filter(d => d.id !== activeDraftId)
  if (list.length === 0) {
    el.innerHTML = '<div class="drafts-modal-empty">No saved drafts.</div>'
    return
  }
  const items = list.map(d => {
    const when = new Date(d.updatedAt || Date.now()).toLocaleString()
    const previewRaw = (d.content || '(no text)').slice(0, 80)
    const preview = escapeText(previewRaw)
    return `<div class="entry" data-id="${d.id}">
      <span class="entry-text">${preview}</span>
      <span class="entry-meta">${when}</span>
      <span class="entry-actions">
        <button type="button" data-action="load" data-id="${d.id}">Open</button>
        <button type="button" data-action="delete" data-id="${d.id}">Delete</button>
      </span>
    </div>`
  })
  el.innerHTML = items.join('')
}

export function showDraftsModal() {
  if (!dom.draftsModal) return
  renderSavedDraftsList()
  dom.draftsModal.classList.remove('hidden')
}

export function hideDraftsModal() {
  if (!dom.draftsModal) return
  dom.draftsModal.classList.add('hidden')
}

function renderScheduledList() {
  const el = dom.expScheduledList
  if (!el || !state.scheduler) return
  const list = state.scheduler.list()
  if (list.length === 0) {
    el.classList.add('hidden')
    el.innerHTML = ''
    return
  }
  el.classList.remove('hidden')
  const items = list.map(entry => {
    const when = new Date(entry.sendAt).toLocaleString()
    const previewRaw = (entry.payload.content || '(no text)').slice(0, 60)
    const preview = escapeText(previewRaw)
    const lockTag = entry.paywall ? ' 🔒' : ''
    return `<div class="entry" data-id="${entry.id}">
      <span class="entry-text">${preview}${lockTag}</span>
      <span class="entry-meta">${when}</span>
      <span class="entry-actions">
        <button type="button" data-sched-action="cancel" data-id="${entry.id}">Cancel</button>
      </span>
    </div>`
  })
  el.innerHTML = `<div class="list-title">Scheduled posts</div>${items.join('')}`
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Rebuild the poll options list to two empty inputs (the minimum valid poll).
 */
function resetPollOptions() {
  const list = document.getElementById('expPollOptionsList')
  if (!list) return
  list.innerHTML = ''
  addPollOptionRow()
  addPollOptionRow()
}

/**
 * Append one option input row. Enforces the compose-time length cap. The cap
 * is also re-checked at send time and again on ingest in lib/events.js.
 */
function addPollOptionRow(initial = '') {
  const list = document.getElementById('expPollOptionsList')
  if (!list) return
  const rows = list.querySelectorAll('.poll-option-row')
  if (rows.length >= POLL_MAX_OPTIONS) return

  const row = document.createElement('div')
  row.className = 'poll-option-row'
  row.style.display = 'flex'
  row.style.gap = '6px'
  row.style.marginBottom = '6px'

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'poll-option-input'
  input.maxLength = POLL_MAX_OPTION_LEN
  input.placeholder = `Option ${rows.length + 1}`
  input.value = initial
  input.style.flex = '1'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'btn-secondary poll-option-remove'
  remove.textContent = '×'
  remove.title = 'Remove option'
  remove.addEventListener('click', () => {
    const remaining = list.querySelectorAll('.poll-option-row')
    if (remaining.length <= 2) return
    row.remove()
  })

  row.appendChild(input)
  row.appendChild(remove)
  list.appendChild(row)
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
  const composerEmpty = dom.expPostContent.value.trim().length === 0 &&
    expPendingMedia.length === 0 && expPendingFiles.length === 0
  const pollOn = !!document.getElementById('expPollToggle')?.checked
  const pollQuestionFilled = ((document.getElementById('expPollQuestion')?.value) || '').trim().length > 0
  const articleOn = !!document.getElementById('expArticleToggle')?.checked
  const articleTitleFilled = ((document.getElementById('expArticleTitle')?.value) || '').trim().length > 0
  const articleBodyFilled = dom.expPostContent.value.trim().length > 0

  // Enable rules:
  //  - Article mode: title AND body must be filled.
  //  - Poll mode: either composer text or poll question alone is enough.
  //  - Default: standard composer-empty check.
  if (articleOn) {
    dom.expPostBtn.disabled = !(articleTitleFilled && articleBodyFilled)
  } else if (pollOn && pollQuestionFilled) {
    dom.expPostBtn.disabled = false
  } else {
    dom.expPostBtn.disabled = composerEmpty
  }

  updateTagHint()
  updateMetadataWarning()
  scheduleDraftAutosave()
}

/**
 * Show a warning when a video or generic file is attached — Swarmnero does
 * not strip metadata from those (only JPEG/PNG/WEBP images are re-encoded
 * through a canvas to drop EXIF). Hidden when only images are queued.
 */
function updateMetadataWarning() {
  const hint = document.getElementById('metadataWarningHint')
  if (!hint) return
  const hasVideo = expPendingMedia.some(f => f.type?.startsWith('video/'))
  const hasFile = expPendingFiles.length > 0
  const hintText = hint.querySelector('.hint-text')
  if (!hintText) return

  if (hasVideo && hasFile) {
    hintText.innerHTML = '<strong>Heads up:</strong> video and file metadata / filenames are <strong>not</strong> removed. Consider stripping GPS, timestamps, and identifying filenames before attaching.'
    hint.classList.remove('hidden')
  } else if (hasVideo) {
    hintText.innerHTML = '<strong>Heads up:</strong> video metadata is <strong>not</strong> removed. Consider stripping GPS and timestamps before attaching.'
    hint.classList.remove('hidden')
  } else if (hasFile) {
    hintText.innerHTML = '<strong>Heads up:</strong> the filename and document metadata are <strong>not</strong> removed. Rename or clean the file before attaching if it could contain identifying info.'
    hint.classList.remove('hidden')
  } else {
    hint.classList.add('hidden')
  }
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
 * Dispatch the post button — either schedule the post or publish now
 * depending on the schedule toggle.
 */
async function handlePostBtnClick(refreshUI) {
  const scheduleOn = !!dom.expScheduleToggle?.checked
  if (scheduleOn) {
    await scheduleExpandedPost(refreshUI)
  } else {
    await createExpandedPost(refreshUI)
  }
}

/**
 * Queue the current composer state as a scheduled post. Stores the UNSIGNED
 * payload — signing happens inside the scheduler at fire time.
 */
async function scheduleExpandedPost(refreshUI) {
  if (!state.scheduler) {
    alert('Scheduler is not ready yet — try again in a moment.')
    return
  }
  const content = dom.expPostContent.value.trim()
  const pollToggle = document.getElementById('expPollToggle')
  const isPoll = !!pollToggle?.checked

  const whenStr = dom.expScheduleAt?.value || ''
  if (!whenStr) {
    alert('Pick a send time first.')
    return
  }
  const sendAt = new Date(whenStr).getTime()
  if (!Number.isFinite(sendAt)) {
    alert('Invalid send time.')
    return
  }

  // Branch 1: scheduled poll
  if (isPoll) {
    if (expPendingMedia.length > 0 || expPendingFiles.length > 0) {
      alert('Polls cannot include media attachments. Remove attachments or disable the poll toggle.')
      return
    }
    const questionInput = document.getElementById('expPollQuestion')
    const durationSelect = document.getElementById('expPollDuration')
    const rawQuestion = (questionInput?.value || '').trim()
    if (rawQuestion && content) {
      alert("Polls do not carry post text. Either clear the post text above, or clear the poll question field — not both.")
      return
    }
    const finalQuestion = rawQuestion || content
    if (!finalQuestion) {
      alert('Please enter a poll question (in the question field, or in the post text above).')
      return
    }
    const optionInputs = Array.from(document.querySelectorAll('.poll-option-input'))
    const options = optionInputs.map(i => i.value.trim()).filter(v => v.length > 0)
    if (options.length < 2) {
      alert('A poll needs at least 2 non-empty options.')
      return
    }
    if (options.length > POLL_MAX_OPTIONS) {
      alert(`Polls are capped at ${POLL_MAX_OPTIONS} options.`)
      return
    }
    if (options.some(o => o.length > POLL_MAX_OPTION_LEN)) {
      alert(`Each poll option is limited to ${POLL_MAX_OPTION_LEN} characters.`)
      return
    }
    const durationMs = parseInt(durationSelect?.value || '86400000', 10)
    if (!Number.isFinite(durationMs) || durationMs < 60 * 1000) {
      alert('Please choose a valid poll duration.')
      return
    }
    dom.expPostBtn.disabled = true
    try {
      state.scheduler.schedule({
        payload: {
          kind: 'poll',
          poll: { question: finalQuestion, options, durationMs }
        },
        sendAt
      })
      if (activeDraftId && state.drafts) state.drafts.delete(activeDraftId)
      clearExpandedComposer()
      hideExpandedComposer()
      renderScheduledList()
      await refreshUI()
    } catch (err) {
      alert('Could not schedule poll: ' + err.message)
    }
    dom.expPostBtn.disabled = false
    return
  }

  if (!content && expPendingMedia.length === 0 && expPendingFiles.length === 0) return

  const paywallToggle = document.getElementById('expPaywallToggle')
  const isPaywalled = !!paywallToggle?.checked
  let paywallMeta = null
  if (isPaywalled) {
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
    paywallMeta = { price, preview }
  }

  // Capture content warning
  const cwToggle = document.getElementById('expCwToggle')
  const cwLabelInput = document.getElementById('expCwLabel')
  let cw = null
  if (cwToggle?.checked) {
    const raw = cwLabelInput?.value?.trim() || ''
    if (!raw) {
      alert('Please enter a content warning label, or turn the warning off.')
      return
    }
    if (raw.length > MAX_CW_LENGTH) {
      alert(`Content warning label is limited to ${MAX_CW_LENGTH} characters.`)
      return
    }
    cw = raw
  }

  dom.expPostBtn.disabled = true
  try {
    // Upload media + files NOW (same as immediate publish path). The stored
    // Hyperdrive refs are durable; at fire time we only sign the metadata.
    const uploadedMedia = []
    if (state.media && expPendingMedia.length > 0) {
      for (const file of expPendingMedia) {
        const result = file.type.startsWith('video/')
          ? await state.media.storeVideo(file, file.name)
          : await state.media.storeImage(file, file.name)
        uploadedMedia.push(result)
      }
    }
    if (state.media && expPendingFiles.length > 0) {
      for (const file of expPendingFiles) {
        uploadedMedia.push(await state.media.storeFile(file, file.name))
      }
    }

    state.scheduler.schedule({
      payload: {
        kind: 'post',
        content,
        media: uploadedMedia,
        cw
      },
      sendAt,
      paywall: paywallMeta
    })

    // Clear composer + drop associated draft once successfully queued.
    if (activeDraftId && state.drafts) state.drafts.delete(activeDraftId)
    clearExpandedComposer()
    hideExpandedComposer()
    renderScheduledList()
    await refreshUI()
  } catch (err) {
    alert('Could not schedule: ' + err.message)
  }
  dom.expPostBtn.disabled = false
}

/**
 * Publish a long-form article from the composer.
 *
 * Reads title / summary / cover / body / cw / paywall fields, runs the same
 * upload pipeline as posts for the cover image (so EXIF stripping happens),
 * and appends a single article event. Body is markdown source — sanitized
 * at render time, never trusted as HTML.
 *
 * Mutually exclusive with poll mode (a poll is its own event type). Media /
 * file attachments from the regular composer are dropped — articles use only
 * the cover image. CW + paywall toggles still apply.
 */
async function createArticleFromComposer(refreshUI) {
  const titleInput = document.getElementById('expArticleTitle')
  const summaryInput = document.getElementById('expArticleSummary')
  const title = (titleInput?.value || '').trim()
  const summary = (summaryInput?.value || '').trim()
  const body = dom.expPostContent.value
  if (!title) {
    alert('Please enter an article title.')
    return
  }
  if (title.length > ARTICLE_MAX_TITLE) {
    alert(`Title must be ${ARTICLE_MAX_TITLE} characters or fewer.`)
    return
  }
  if (summary.length > ARTICLE_MAX_SUMMARY) {
    alert(`Summary must be ${ARTICLE_MAX_SUMMARY} characters or fewer.`)
    return
  }
  if (!body.trim()) {
    alert('Article body cannot be empty.')
    return
  }
  if (body.length > ARTICLE_MAX_BODY) {
    alert(`Article body must be ${ARTICLE_MAX_BODY} characters or fewer.`)
    return
  }

  // CW
  const cwToggle = document.getElementById('expCwToggle')
  const cwLabelInput = document.getElementById('expCwLabel')
  let cw = null
  if (cwToggle?.checked) {
    const raw = cwLabelInput?.value?.trim() || ''
    if (!raw) {
      alert('Please enter a content warning label, or turn the warning off.')
      return
    }
    if (raw.length > MAX_CW_LENGTH) {
      alert(`Content warning must be ${MAX_CW_LENGTH} characters or fewer.`)
      return
    }
    cw = raw
  }

  // Paywall (optional)
  const paywallToggle = document.getElementById('expPaywallToggle')
  const isPaywalled = !!paywallToggle?.checked
  if (isPaywalled && !wallet.isWalletUnlocked()) {
    alert('Your wallet must be unlocked to create a paywalled article.')
    return
  }

  // Tags from body — same hashtag extractor as posts.
  const tags = extractHashtags(body)

  dom.expPostBtn.disabled = true
  try {
    // Upload cover (if any) — runs through the same EXIF-stripping image
    // pipeline as regular post media.
    let cover = null
    if (expPendingArticleCover && state.media) {
      cover = await state.media.storeImage(expPendingArticleCover, expPendingArticleCover.name)
    }

    let articleEvent
    if (isPaywalled) {
      const priceInput = document.getElementById('expPaywallPrice')
      const previewInput = document.getElementById('expPaywallPreview')
      const price = priceInput?.value?.trim()
      const preview = previewInput?.value?.trim()
      if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) {
        alert('Please enter a valid XMR price for the paywall.')
        dom.expPostBtn.disabled = false
        return
      }
      if (!preview) {
        alert('Please enter a public preview text for the paywall.')
        dom.expPostBtn.disabled = false
        return
      }
      const paywallFields = await createPaywalledPost({
        content: body,
        media: [],
        priceXmr: price,
        preview
      })
      articleEvent = createArticleEvent({
        title,
        summary,
        cover,
        body: '',
        tags,
        cw,
        paywall: {
          price: paywallFields.paywallPrice,
          preview: paywallFields.paywallPreview,
          encrypted: paywallFields.paywallEncrypted,
          subaddress: paywallFields.paywallSubaddress,
          subaddressIndex: paywallFields.paywallSubaddressIndex
        }
      })
      const appended = await state.feed.append(articleEvent)
      if (appended && appended.timestamp) {
        persistContentKey(appended.timestamp, paywallFields.contentKeyHex)
        cacheUnlockedContent(appended.pubkey, appended.timestamp, body, [])
      }
    } else {
      articleEvent = createArticleEvent({
        title,
        summary,
        cover,
        body,
        tags,
        cw
      })
      await state.feed.append(articleEvent)
    }

    schedulePublicSiteRebuild()
    if (activeDraftId && state.drafts) state.drafts.delete(activeDraftId)
    clearExpandedComposer()
    hideExpandedComposer()
    await refreshUI()
  } catch (err) {
    alert('Error creating article: ' + err.message)
  }
  dom.expPostBtn.disabled = false
}

/**
 * Create post from expanded composer
 */
async function createExpandedPost(refreshUI) {
  const content = dom.expPostContent.value.trim()

  // Article mode short-circuits the regular post path. Article events are
  // top-level (cannot also be polls). CW + paywall toggles work alongside it.
  const articleToggle = document.getElementById('expArticleToggle')
  const isArticle = !!articleToggle?.checked
  if (isArticle) {
    return createArticleFromComposer(refreshUI)
  }

  // Check poll toggle first — poll posts have their own flow and do not carry
  // media / paywall fields (the poll event is self-contained).
  const pollToggle = document.getElementById('expPollToggle')
  const isPoll = !!pollToggle?.checked

  if (!isPoll && !content && expPendingMedia.length === 0 && expPendingFiles.length === 0) return

  if (isPoll) {
    if (expPendingMedia.length > 0 || expPendingFiles.length > 0) {
      alert('Polls cannot include media attachments. Remove attachments or disable the poll toggle.')
      return
    }
    const questionInput = document.getElementById('expPollQuestion')
    const durationSelect = document.getElementById('expPollDuration')
    const rawQuestion = (questionInput?.value || '').trim()
    if (rawQuestion && content) {
      alert("Polls do not carry post text. Either clear the post text above, or clear the poll question field — not both.")
      return
    }
    const finalQuestion = rawQuestion || content
    if (!finalQuestion) {
      alert('Please enter a poll question (in the question field, or in the post text above).')
      return
    }
    const optionInputs = Array.from(document.querySelectorAll('.poll-option-input'))
    const options = optionInputs.map(i => i.value.trim()).filter(v => v.length > 0)
    const durationMs = parseInt(durationSelect?.value || '86400000', 10)
    if (!Number.isFinite(durationMs) || durationMs < 60 * 1000) {
      alert('Please choose a valid poll duration.')
      return
    }
    if (options.length < 2) {
      alert('A poll needs at least 2 non-empty options.')
      return
    }
    if (options.length > POLL_MAX_OPTIONS) {
      alert(`Polls are capped at ${POLL_MAX_OPTIONS} options.`)
      return
    }
    if (options.some(o => o.length > POLL_MAX_OPTION_LEN)) {
      alert(`Each poll option is limited to ${POLL_MAX_OPTION_LEN} characters.`)
      return
    }

    dom.expPostBtn.disabled = true
    try {
      const expiresAt = Date.now() + durationMs
      await state.feed.append(createPollEvent({
        question: finalQuestion,
        options,
        expiresAt
      }))
      schedulePublicSiteRebuild()
      clearExpandedComposer()
      hideExpandedComposer()
      await refreshUI()
    } catch (err) {
      alert('Error creating poll: ' + err.message)
    }
    dom.expPostBtn.disabled = false
    return
  }

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

  // Check content warning toggle
  const cwToggle = document.getElementById('expCwToggle')
  const cwLabelInput = document.getElementById('expCwLabel')
  let cw = null
  if (cwToggle?.checked) {
    const raw = cwLabelInput?.value?.trim() || ''
    if (!raw) {
      alert('Please enter a content warning label, or turn the warning off.')
      return
    }
    if (raw.length > MAX_CW_LENGTH) {
      alert(`Content warning must be ${MAX_CW_LENGTH} characters or fewer.`)
      return
    }
    cw = raw
  }

  dom.expPostBtn.disabled = true
  try {
    // Upload pending media. Images go through storeImage individually (the
    // EXIF stripper runs per-file) — no spread, no early-exit, no shared
    // buffer reuse that could publish an unstripped image.
    const uploadedMedia = []
    if (state.media && expPendingMedia.length > 0) {
      for (const file of expPendingMedia) {
        if (uploadedMedia.length >= MAX_MEDIA_PER_POST) break
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
        paywallSubaddressIndex: paywallFields.paywallSubaddressIndex,
        cw
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
        subaddressIndex: subaddress_index,
        cw
      }))
    }

    schedulePublicSiteRebuild()

    // Successful publish — drop the associated draft.
    if (activeDraftId && state.drafts) {
      state.drafts.delete(activeDraftId)
    }
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

  // Close/cancel buttons — if autosave is pending, flush it so nothing is lost.
  dom.closeExpandedComposer.addEventListener('click', async () => {
    if (draftAutosaveTimer) {
      clearTimeout(draftAutosaveTimer)
      draftAutosaveTimer = null
      await saveDraftNow({ fromAutosave: true })
    }
    if (state.drafts) state.drafts.flush()
    hideExpandedComposer()
    clearExpandedComposer()
  })

  dom.cancelExpandedPost.addEventListener('click', async () => {
    if (draftAutosaveTimer) {
      clearTimeout(draftAutosaveTimer)
      draftAutosaveTimer = null
      await saveDraftNow({ fromAutosave: true })
    }
    if (state.drafts) state.drafts.flush()
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
    let rejected = 0
    for (const file of files) {
      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        if (expPendingMedia.length >= MAX_MEDIA_PER_POST) {
          rejected++
          continue
        }
        expPendingMedia.push(file)
        addExpMediaPreview(file)
      }
    }
    dom.expMediaInput.value = ''
    if (rejected > 0) {
      alert(`Only ${MAX_MEDIA_PER_POST} attachments allowed per post. ${rejected} file(s) were skipped.`)
    }
    updateExpCharCount()
  })

  // File button
  dom.expFileBtn.addEventListener('click', () => {
    dom.expFileInput.click()
  })

  // Handle file selection. Images/videos attached through the generic file
  // button are routed to the media pipeline so EXIF stripping (images) still
  // runs — otherwise they'd hit storeFile which keeps raw bytes + filename.
  dom.expFileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files)
    let rejected = 0
    for (const file of files) {
      if (file.type?.startsWith('image/') || file.type?.startsWith('video/')) {
        if (expPendingMedia.length >= MAX_MEDIA_PER_POST) {
          rejected++
          continue
        }
        expPendingMedia.push(file)
        addExpMediaPreview(file)
      } else {
        expPendingFiles.push(file)
        addExpFilePreview(file)
      }
    }
    dom.expFileInput.value = ''
    if (rejected > 0) {
      alert(`Only ${MAX_MEDIA_PER_POST} image/video attachments allowed per post. ${rejected} file(s) were skipped.`)
    }
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

  // Content warning toggle - show/hide label field
  const cwToggle = document.getElementById('expCwToggle')
  const cwFields = document.getElementById('expCwFields')
  const cwLabelInput = document.getElementById('expCwLabel')
  const cwCharCount = document.getElementById('expCwCharCount')
  if (cwToggle && cwFields) {
    cwToggle.addEventListener('change', () => {
      if (cwToggle.checked) {
        cwFields.classList.remove('hidden')
        cwLabelInput?.focus()
      } else {
        cwFields.classList.add('hidden')
      }
    })
  }
  if (cwLabelInput && cwCharCount) {
    cwLabelInput.addEventListener('input', () => {
      cwCharCount.textContent = cwLabelInput.value.length
    })
  }

  // Post button — may schedule or publish depending on toggle
  dom.expPostBtn.addEventListener('click', () => handlePostBtnClick(refreshUI))

  // Save draft button
  if (dom.expSaveDraftBtn) {
    dom.expSaveDraftBtn.addEventListener('click', async () => {
      try {
        await saveDraftNow({ fromAutosave: false })
        if (state.drafts) state.drafts.flush()
        clearExpandedComposer()
        hideExpandedComposer()
      } catch (err) {
        alert('Could not save draft: ' + err.message)
      }
    })
  }

  // Schedule toggle — show/hide schedule fields
  if (dom.expScheduleToggle && dom.expScheduleFields) {
    dom.expScheduleToggle.addEventListener('change', () => {
      if (dom.expScheduleToggle.checked) {
        dom.expScheduleFields.classList.remove('hidden')
        // Default send time: 1 hour from now, formatted for datetime-local
        if (dom.expScheduleAt && !dom.expScheduleAt.value) {
          const d = new Date(Date.now() + 60 * 60 * 1000)
          const pad = (n) => String(n).padStart(2, '0')
          const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
          dom.expScheduleAt.value = iso
        }
        if (dom.expPostBtn) dom.expPostBtn.textContent = 'Schedule'
      } else {
        dom.expScheduleFields.classList.add('hidden')
        if (dom.expPostBtn) dom.expPostBtn.textContent = 'Post'
      }
    })
  }

  // Click-delegation on the drafts modal list
  if (dom.draftsModalList) {
    dom.draftsModalList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]')
      if (!btn) return
      const id = btn.getAttribute('data-id')
      const action = btn.getAttribute('data-action')
      if (action === 'load') {
        hideDraftsModal()
        showExpandedComposer()
        await loadDraft(id)
      } else if (action === 'delete') {
        state.drafts?.delete(id)
        renderSavedDraftsList()
      }
    })
  }
  const draftsModalCloseBtn = document.getElementById('draftsModalClose')
  if (draftsModalCloseBtn) {
    draftsModalCloseBtn.addEventListener('click', hideDraftsModal)
  }
  if (dom.expScheduledList) {
    dom.expScheduledList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sched-action]')
      if (!btn) return
      const id = btn.getAttribute('data-id')
      const action = btn.getAttribute('data-sched-action')
      if (action === 'cancel') {
        state.scheduler?.cancel(id)
        renderScheduledList()
      }
    })
  }

  // Poll toggle - mutually exclusive with paywall mode (a poll is its own top-level event)
  const pollToggle = document.getElementById('expPollToggle')
  const pollFields = document.getElementById('expPollFields')
  const pollAddBtn = document.getElementById('expPollAddOptionBtn')
  if (pollToggle && pollFields) {
    pollToggle.addEventListener('change', () => {
      if (pollToggle.checked) {
        if (paywallToggle?.checked) {
          paywallToggle.checked = false
          paywallFields?.classList.add('hidden')
        }
        pollFields.classList.remove('hidden')
        const list = document.getElementById('expPollOptionsList')
        if (list && list.children.length === 0) resetPollOptions()
      } else {
        pollFields.classList.add('hidden')
      }
      updateExpCharCount()
    })
  }
  const pollQuestionInput = document.getElementById('expPollQuestion')
  if (pollQuestionInput) {
    pollQuestionInput.addEventListener('input', updateExpCharCount)
  }
  if (paywallToggle && pollToggle) {
    paywallToggle.addEventListener('change', () => {
      if (paywallToggle.checked && pollToggle.checked) {
        pollToggle.checked = false
        pollFields?.classList.add('hidden')
      }
    })
  }
  if (pollAddBtn) {
    pollAddBtn.addEventListener('click', () => addPollOptionRow())
  }

  // Article toggle — mutually exclusive with poll mode (an article is its own
  // event type, not a poll). CW + paywall toggles work alongside it.
  const articleToggle = document.getElementById('expArticleToggle')
  const articleFields = document.getElementById('expArticleFields')
  const articleTitleInput = document.getElementById('expArticleTitle')
  const articleSummaryInput = document.getElementById('expArticleSummary')
  const articleTitleCount = document.getElementById('expArticleTitleCount')
  const articleSummaryCount = document.getElementById('expArticleSummaryCount')
  const articleCoverBtn = document.getElementById('expArticleCoverBtn')
  const articleCoverInput = document.getElementById('expArticleCoverInput')
  const articleCoverPreview = document.getElementById('expArticleCoverPreview')
  const articlePreviewBtn = document.getElementById('expArticlePreviewBtn')
  const articlePreviewEl = document.getElementById('expArticlePreview')

  if (articleToggle && articleFields) {
    articleToggle.addEventListener('change', () => {
      if (articleToggle.checked) {
        // Disable poll mode (mutually exclusive)
        if (pollToggle?.checked) {
          pollToggle.checked = false
          pollFields?.classList.add('hidden')
        }
        articleFields.classList.remove('hidden')
        // Grow the body textarea via a class on the expanded composer
        dom.expandedComposer.classList.add('article-mode')
        // Update placeholder hint
        if (dom.expPostContent) {
          dom.expPostContent.placeholder = 'Write the article body in Markdown. Headings, bold, italic, lists, links, and images supported.'
        }
        articleTitleInput?.focus()
      } else {
        articleFields.classList.add('hidden')
        dom.expandedComposer.classList.remove('article-mode')
        if (dom.expPostContent) {
          dom.expPostContent.placeholder = "What's happening? Write something longer..."
        }
        // Hide preview if open
        if (articlePreviewEl) {
          articlePreviewEl.classList.add('hidden')
          articlePreviewEl.innerHTML = ''
        }
      }
      updateExpCharCount()
    })
  }

  // Article + poll mutual exclusion (the other direction — poll toggle off
  // article toggle if both somehow turned on)
  if (pollToggle && articleToggle) {
    pollToggle.addEventListener('change', () => {
      if (pollToggle.checked && articleToggle.checked) {
        articleToggle.checked = false
        articleFields?.classList.add('hidden')
        dom.expandedComposer.classList.remove('article-mode')
      }
    })
  }

  if (articleTitleInput && articleTitleCount) {
    articleTitleInput.addEventListener('input', () => {
      articleTitleCount.textContent = articleTitleInput.value.length
      updateExpCharCount()
    })
  }
  if (articleSummaryInput && articleSummaryCount) {
    articleSummaryInput.addEventListener('input', () => {
      articleSummaryCount.textContent = articleSummaryInput.value.length
    })
  }
  if (articleCoverBtn && articleCoverInput) {
    articleCoverBtn.addEventListener('click', () => articleCoverInput.click())
  }
  if (articleCoverInput && articleCoverPreview) {
    articleCoverInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0]
      if (!file) return
      if (!file.type.startsWith('image/')) {
        alert('Cover must be an image.')
        return
      }
      expPendingArticleCover = file
      const reader = new FileReader()
      reader.onload = (ev) => {
        articleCoverPreview.innerHTML = `
          <div class="article-cover-preview-item">
            <img src="${ev.target.result}" alt="cover preview">
            <button type="button" class="remove-media" id="expArticleCoverRemove" title="Remove cover">&times;</button>
          </div>
        `
        const removeBtn = document.getElementById('expArticleCoverRemove')
        if (removeBtn) {
          removeBtn.addEventListener('click', () => {
            expPendingArticleCover = null
            articleCoverPreview.innerHTML = ''
            articleCoverInput.value = ''
          })
        }
      }
      reader.readAsDataURL(file)
    })
  }
  if (articlePreviewBtn && articlePreviewEl) {
    articlePreviewBtn.addEventListener('click', () => {
      const isHidden = articlePreviewEl.classList.contains('hidden')
      if (isHidden) {
        const body = dom.expPostContent.value
        // renderArticleMarkdown is the sanitizing renderer — safe to innerHTML.
        // PHASE 2A SANITIZER GATE — markdown.js is the only path we trust here.
        articlePreviewEl.innerHTML = renderArticleMarkdown(body)
        articlePreviewEl.classList.remove('hidden')
        articlePreviewBtn.textContent = 'Hide preview'
      } else {
        articlePreviewEl.classList.add('hidden')
        articlePreviewEl.innerHTML = ''
        articlePreviewBtn.textContent = 'Preview body'
      }
    })
  }

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
