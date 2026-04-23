/**
 * Storage panel — Phase 1
 *
 * Shows local disk usage and lets the user clear a follow's cached feed
 * (or all follows' feeds) to reclaim space. Also persists cap + per-follow
 * keep settings that Phase 2 auto-prune will consume.
 */

import { state } from '../state.js'
import { escapeHtml } from '../utils/dom.js'
import { formatBytes } from '../../lib/storage-manager.js'

const CAP_OPTIONS = [
  { label: '250 MB',   bytes: 250 * 1024 * 1024 },
  { label: '500 MB',   bytes: 500 * 1024 * 1024 },
  { label: '1 GB',     bytes: 1024 * 1024 * 1024 },
  { label: '2 GB',     bytes: 2 * 1024 * 1024 * 1024 },
  { label: '5 GB',     bytes: 5 * 1024 * 1024 * 1024 },
  { label: 'Unlimited', bytes: 0 }
]

const KEEP_OPTIONS = [50, 100, 200, 500, 1000]

function displayName(peer) {
  if (peer.name) return peer.name
  if (peer.pubkey) return `User ${peer.pubkey.slice(0, 8)}…${peer.pubkey.slice(-6)}`
  return `Follow ${peer.swarmId.slice(0, 8)}…`
}

export async function renderStorage() {
  const container = document.getElementById('storageContent')
  if (!container) return

  const sm = state.storageManager
  if (!sm) {
    container.innerHTML = '<p class="hint">Storage manager not initialized.</p>'
    return
  }

  sm.loadConfig()

  // Header with loading state while disk walk + per-core info run
  container.innerHTML = `
    <div class="storage-container">
      <h3>Storage</h3>
      <div id="storageSummary" class="storage-summary hint">Scanning disk usage…</div>
      <div id="storageSettings"></div>
      <div id="storageFollows"></div>
      <div id="storageClearAll"></div>
    </div>
  `

  const [summary, onDisk] = await Promise.all([
    sm.getSummary(),
    sm.getTotalOnDisk().catch(err => {
      console.warn('[Storage] getTotalOnDisk failed:', err.message)
      return null
    })
  ])

  renderSummary(summary, onDisk)
  renderSettings(summary)
  renderLastPrune(sm.lastPruneResult)
  renderFollowsList(summary)
  renderClearAll(summary)

  wireHandlers()
}

function formatRelative(ts) {
  if (!ts) return ''
  const ms = Date.now() - ts
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function mediaSummaryLine(media) {
  if (!media || media.skipped) return ''
  if (!media.driveKeysScanned) return ''
  return ` + ${formatBytes(media.bytesCleared)} media across ${media.driveKeysScanned} drive(s)`
}

function renderLastPrune(result) {
  const el = document.getElementById('storagePruneStatus')
  if (!el) return
  if (!result) {
    el.innerHTML = ''
    return
  }
  if (result.skipped) {
    const mediaNote = mediaSummaryLine(result.media)
    el.innerHTML = `<span class="hint">Last auto-prune: skipped (${escapeHtml(result.reason || 'n/a')})${mediaNote} · ${formatRelative(result.ranAt)}</span>`
    return
  }
  const freed = Math.max(0, result.startBytes - result.endBytes)
  const mediaNote = mediaSummaryLine(result.media)
  const warn = result.stillOverCap
    ? ' <span class="storage-warning-inline">still over cap — reduce keep-per-follow or raise cap</span>'
    : ''
  el.innerHTML = `<span class="hint">Last prune: freed ${formatBytes(freed)} across ${result.followsTouched} follow(s), ${result.blocksCleared} block(s)${mediaNote} · ${formatRelative(result.ranAt)}</span>${warn}`
}

function renderSummary(summary, onDisk) {
  const el = document.getElementById('storageSummary')
  if (!el) return

  const cap = summary.capBytes
  const used = onDisk?.total ?? summary.feedsBytes
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0
  const overCap = cap > 0 && used > cap
  const capStr = cap > 0 ? formatBytes(cap) : 'Unlimited'

  const parts = onDisk ? `
    <span class="storage-legend feeds">Feeds &amp; media ${formatBytes(onDisk.cores)}</span>
    <span class="storage-legend idx">Index ${formatBytes(onDisk.index)}</span>
    ${onDisk.other > 0 ? `<span class="storage-legend other">Other ${formatBytes(onDisk.other)}</span>` : ''}
  ` : `
    <span class="storage-legend feeds">Feeds ${formatBytes(summary.feedsBytes)}</span>
  `

  el.classList.remove('hint')
  el.innerHTML = `
    <div class="storage-usage-line">
      <strong>${formatBytes(used)}</strong>
      <span class="hint">of ${escapeHtml(capStr)}${onDisk ? '' : ' (estimate)'}</span>
    </div>
    <div class="storage-bar ${overCap ? 'storage-bar-over' : ''}">
      <div class="storage-bar-fill" style="width:${pct.toFixed(1)}%"></div>
    </div>
    <div class="storage-legend-row">${parts}</div>
    ${overCap ? '<div class="storage-warning">Over cap — Phase 2 auto-prune will trim oldest blocks from largest follows.</div>' : ''}
  `
}

function renderSettings(summary) {
  const el = document.getElementById('storageSettings')
  if (!el) return

  el.innerHTML = `
    <div class="storage-section">
      <div class="setting-row">
        <label>Cap</label>
        <div class="setting-input-group">
          <select id="storageCapSelect" class="setting-input">
            ${CAP_OPTIONS.map(o =>
              `<option value="${o.bytes}" ${o.bytes === summary.capBytes ? 'selected' : ''}>${o.label}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row">
        <label>Keep per follow (most recent)</label>
        <div class="setting-input-group">
          <select id="storageKeepSelect" class="setting-input">
            ${KEEP_OPTIONS.map(n =>
              `<option value="${n}" ${n === summary.keepPerFollow ? 'selected' : ''}>${n} posts</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row">
        <label>Auto-prune when over cap</label>
        <div class="setting-input-group">
          <label class="toggle">
            <input type="checkbox" id="storageAutoPrune" ${summary.autoPrune ? 'checked' : ''}>
            <span>${summary.autoPrune ? 'On' : 'Off'}</span>
          </label>
        </div>
        <span class="hint">Runs 10s after startup and every 30 min when over cap.</span>
      </div>
      <div class="setting-row">
        <button id="storageRunPruneBtn" class="btn-small btn-primary">Run prune now</button>
        <div id="storagePruneStatus" class="storage-prune-status"></div>
      </div>
    </div>
  `
}

function renderFollowsList(summary) {
  const el = document.getElementById('storageFollows')
  if (!el) return

  if (summary.peers.length === 0) {
    el.innerHTML = `
      <div class="storage-section">
        <h4>Follows</h4>
        <p class="hint">You're not following anyone yet.</p>
      </div>
    `
    return
  }

  const rows = summary.peers.map(p => `
    <div class="storage-follow-row" data-swarmid="${escapeHtml(p.swarmId)}">
      <div class="storage-follow-info">
        <div class="storage-follow-name">${escapeHtml(displayName(p))}</div>
        <div class="storage-follow-meta hint">
          ${formatBytes(p.bytes)} · ${p.length} block${p.length === 1 ? '' : 's'}
        </div>
      </div>
      <button class="btn-small storage-clear-btn" data-swarmid="${escapeHtml(p.swarmId)}">Clear</button>
    </div>
  `).join('')

  el.innerHTML = `
    <div class="storage-section">
      <h4>Follows by size (${summary.peerCount})</h4>
      <p class="hint">Clearing purges downloaded blocks. Posts re-fetch when you browse the profile or scroll far enough.</p>
      <div class="storage-follows-list">${rows}</div>
    </div>
  `
}

function renderClearAll(summary) {
  const el = document.getElementById('storageClearAll')
  if (!el) return
  if (summary.peers.length === 0) {
    el.innerHTML = ''
    return
  }
  el.innerHTML = `
    <div class="storage-section">
      <button id="storageClearAllBtn" class="btn-danger">Clear all follows' cached posts</button>
      <p class="hint">Own feed is never touched.</p>
    </div>
  `
}

function wireHandlers() {
  const capSel = document.getElementById('storageCapSelect')
  const keepSel = document.getElementById('storageKeepSelect')
  const autoPrune = document.getElementById('storageAutoPrune')
  const clearAll = document.getElementById('storageClearAllBtn')
  const runPrune = document.getElementById('storageRunPruneBtn')
  const sm = state.storageManager

  if (capSel) {
    capSel.addEventListener('change', () => {
      sm.saveConfig({ capBytes: parseInt(capSel.value, 10) })
      renderStorage()
    })
  }
  if (keepSel) {
    keepSel.addEventListener('change', () => {
      sm.saveConfig({ keepPerFollow: parseInt(keepSel.value, 10) })
    })
  }
  if (autoPrune) {
    autoPrune.addEventListener('change', () => {
      sm.saveConfig({ autoPrune: autoPrune.checked })
      renderStorage()
    })
  }

  document.querySelectorAll('.storage-clear-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const swarmId = btn.dataset.swarmid
      if (!swarmId) return
      const row = btn.closest('.storage-follow-row')
      const name = row?.querySelector('.storage-follow-name')?.textContent || 'this follow'
      if (!confirm(`Clear cached posts for ${name}?\n\nPosts will re-download from peers when you browse.`)) return

      btn.disabled = true
      btn.textContent = 'Clearing…'
      try {
        const res = await sm.clearPeer(swarmId)
        btn.textContent = `Cleared ${res.cleared}`
        setTimeout(() => renderStorage(), 600)
      } catch (err) {
        console.warn('[Storage] clearPeer failed:', err.message)
        alert('Failed to clear: ' + err.message)
        btn.disabled = false
        btn.textContent = 'Clear'
      }
    })
  })

  if (runPrune) {
    runPrune.addEventListener('click', async () => {
      runPrune.disabled = true
      runPrune.textContent = 'Pruning…'
      try {
        await sm.runPrune()
      } catch (err) {
        console.warn('[Storage] runPrune failed:', err.message)
        alert('Prune failed: ' + err.message)
      } finally {
        runPrune.disabled = false
        runPrune.textContent = 'Run prune now'
        renderStorage()
      }
    })
  }

  if (clearAll) {
    clearAll.addEventListener('click', async () => {
      if (!confirm("Clear cached posts for ALL follows?\n\nYour own feed stays intact. Posts will re-download from peers when you browse.")) return
      clearAll.disabled = true
      clearAll.textContent = 'Clearing…'
      try {
        const res = await sm.clearAllPeers()
        clearAll.textContent = `Cleared ${res.followsCleared} follows`
        setTimeout(() => renderStorage(), 800)
      } catch (err) {
        console.warn('[Storage] clearAllPeers failed:', err.message)
        alert('Failed: ' + err.message)
        clearAll.disabled = false
        clearAll.textContent = "Clear all follows' cached posts"
      }
    })
  }
}
