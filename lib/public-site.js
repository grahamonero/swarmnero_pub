/**
 * Public site publisher — renders your profile + recent posts as static HTML
 * into your own Hyperdrive so anyone with a hyper-aware browser (PearBrowser,
 * Agregore, etc.) can read your profile at:
 *
 *   hyper://{yourMediaDriveKey}/public/profile.html
 *
 * Runs on profile save, post create, and delete events. Opt-out via
 * `publicSiteStorage.setEnabled(pubkeyHex, false)`.
 *
 * Scope:
 * - Public posts only (no replies, DMs, or decrypted paywall content)
 * - Paywalled posts show the preview + "Unlock in Swarmnero" CTA
 * - Last 100 posts
 * - Reply/like/tip counts shown with a "publisher view" disclaimer
 */
import b4a from 'b4a'
import fs from 'fs'
import path from 'path'
import {
  EventType,
  getLatestProfile,
  isPaywalledPost,
  getInteractionCounts
} from './events.js'

const MAX_POSTS = 100

const SITE_BASE = '/public'
const SITE_PATHS = {
  root: '/index.html',
  profile: `${SITE_BASE}/profile.html`,
  postsIndex: `${SITE_BASE}/posts/index.html`,
  post: (ts) => `${SITE_BASE}/posts/${ts}.html`,
  style: `${SITE_BASE}/style.css`,
  rootStyle: '/style.css',
  manifest: `${SITE_BASE}/hyper-profile.json`
}

const PEAR_LINK = 'pear://t6athit7zo98y7wb7kupmeaihxu3p5tft5s55nx5a5s634meppgy'
const SITE_URL = 'https://swarmnero.com'

// --- opt-out settings persisted per-account -----------------------------

export const publicSiteStorage = {
  getSettingsPath(dataDir, pubkeyHex) {
    return path.join(dataDir, `public-site-settings-${pubkeyHex}.json`)
  },
  isEnabled(dataDir, pubkeyHex) {
    if (!dataDir || !pubkeyHex) return false
    try {
      const file = this.getSettingsPath(dataDir, pubkeyHex)
      if (!fs.existsSync(file)) return true // opt-out means default true
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return data?.enabled !== false
    } catch {
      return true
    }
  },
  setEnabled(dataDir, pubkeyHex, enabled) {
    if (!dataDir || !pubkeyHex) return
    try {
      const file = this.getSettingsPath(dataDir, pubkeyHex)
      fs.writeFileSync(file, JSON.stringify({ enabled: !!enabled }, null, 2), 'utf8')
    } catch (err) {
      console.warn('[PublicSite] settings save failed:', err.message)
    }
  }
}

// --- rebuild -----------------------------------------------------------

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatTime(ts) {
  try {
    const d = new Date(ts)
    return d.toLocaleString()
  } catch {
    return ''
  }
}

export async function rebuildPublicSite({ feed, drive, identity, dataDir, media }) {
  // New callers pass `drive` (the dedicated public-site Hyperdrive).
  // Legacy callers passed `media` (the shared media Hyperdrive); we fall
  // back to that for safety but the site should always live in its own drive.
  const targetDrive = drive || media?.drive
  if (!feed || !targetDrive || !identity) return
  if (!publicSiteStorage.isEnabled(dataDir, identity.pubkeyHex)) {
    await clearPublicSite(targetDrive).catch(() => {})
    return
  }

  const events = await feed.read()
  const profile = getLatestProfile(events) || {}

  // Keep the canonical deleted-key filter shape
  const deletedKeys = new Set(
    events
      .filter(e => e.type === EventType.DELETE && e.pubkey)
      .map(e => `${e.pubkey}:${e.post_timestamp}`)
  )

  const myPubkey = identity.pubkeyHex
  const posts = events
    .filter(e =>
      e.type === EventType.POST &&
      e.pubkey === myPubkey &&
      !deletedKeys.has(`${e.pubkey}:${e.timestamp}`)
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_POSTS)

  // Target drive is the dedicated public-site Hyperdrive going forward.
  const drive0 = targetDrive

  // Clean up older layouts — external stylesheets are no longer needed.
  try { await drive0.del(SITE_PATHS.rootStyle) } catch {}
  try { await drive0.del(SITE_PATHS.style) } catch {}

  // Manifest — machine-readable summary
  const driveKeyHex = _driveKeyHex(drive0)
  const manifest = {
    version: 1,
    swarmId: feed.swarmId,
    pubkey: myPubkey,
    driveKey: driveKeyHex,
    profile: {
      name: profile.name || null,
      bio: profile.bio || null,
      website: profile.website || null,
      monero_address: profile.monero_address || null
    },
    postCount: posts.length,
    updated: Date.now()
  }
  await drive0.put(SITE_PATHS.manifest, Buffer.from(JSON.stringify(manifest, null, 2)))

  // Profile page lives at both the drive root (/index.html, so bare
  // hyper://{driveKey}/ URLs render the profile) and /public/profile.html.
  // The same bytes work in both spots because internal links use
  // drive-root-relative paths (public/posts/...) and CSS is inlined.
  const profileHtml = generateProfileHtml(profile, posts, feed.swarmId, events)
  await drive0.put(SITE_PATHS.profile, Buffer.from(profileHtml))
  await drive0.put(SITE_PATHS.root, Buffer.from(profileHtml))
  console.log('[PublicSite] Rebuilt site with', posts.length, 'posts at hyper://' + driveKeyHex + '/')

  // Posts index
  await drive0.put(
    SITE_PATHS.postsIndex,
    Buffer.from(generatePostsIndexHtml(profile, posts, feed.swarmId, events))
  )

  // Individual post pages
  for (const post of posts) {
    const html = generatePostHtml(post, profile, feed.swarmId, events)
    await drive0.put(SITE_PATHS.post(post.timestamp), Buffer.from(html))
  }
}

/**
 * Delete every file the public-site publisher writes. Called when the user
 * disables the opt-out toggle, or as the first step of a full rebuild.
 */
export async function clearPublicSite(drive) {
  if (!drive) return
  const paths = [
    SITE_PATHS.root,
    SITE_PATHS.rootStyle,
    SITE_PATHS.profile,
    SITE_PATHS.postsIndex,
    SITE_PATHS.style,
    SITE_PATHS.manifest
  ]
  for (const p of paths) {
    try { await drive.del(p) } catch {}
  }
  try {
    for await (const entry of drive.list(`${SITE_BASE}/posts/`)) {
      try { await drive.del(entry.key) } catch {}
    }
  } catch {}
}

/**
 * One-time migration: older Swarmnero versions published the hyper-site
 * into the shared media Hyperdrive at /index.html, /public/*, /style.css,
 * which left the rest of the user's media enumerable by hyper-browsers.
 * Remove the public-site files from the media drive so the directory root
 * no longer exposes them. User-uploaded media (images/, videos/, files/)
 * stays untouched.
 */
export async function cleanLegacyPublicSiteFromMedia(media) {
  if (!media?.drive) return
  await clearPublicSite(media.drive)
}

function _driveKeyHex(drive) {
  try {
    if (!drive?.key) return ''
    const k = drive.key
    if (typeof k === 'string') return k
    if (k instanceof Uint8Array) return Array.from(k).map(b => b.toString(16).padStart(2, '0')).join('')
    return ''
  } catch {
    return ''
  }
}

// --- HTML generators ---------------------------------------------------

function pageShell({ title, body, swarmId }) {
  // CSS is inlined so there's no external stylesheet dependency —
  // hyper-browsers inject different <base> tags and can mis-resolve
  // relative paths; inlining sidesteps the whole issue.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>${generateCSS()}</style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a href="index.html" class="brand">Swarmnero profile</a>
      <a class="install-cta" href="${esc(SITE_URL)}" target="_blank" rel="noopener">Get Swarmnero</a>
    </div>
  </header>
  <main class="wrap">
    ${body}
  </main>
  <footer class="site-footer">
    <div class="wrap">
      <p class="footer-small">Published from a Swarmnero client via Hyperdrive. Swarm ID <code>${esc(swarmId || '')}</code></p>
      <p class="footer-small">Interaction counts are this publisher's view — they may differ from what other peers have replicated.</p>
    </div>
  </footer>
</body>
</html>`
}

function generateProfileHtml(profile, posts, swarmId, events) {
  const name = profile.name || 'Anonymous Swarmnero user'
  const bio = profile.bio || ''
  const website = profile.website || ''
  const followingCount = events.filter(e => e.type === EventType.FOLLOW).length -
                         events.filter(e => e.type === EventType.UNFOLLOW).length
  const totalTipsReceived = events
    .filter(e => e.type === EventType.TIP_RECEIVED)
    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0)

  const websiteHtml = website
    ? `<p class="profile-website"><a href="${esc(website)}" target="_blank" rel="noopener">${esc(website)}</a></p>`
    : ''

  const recent = posts.slice(0, 5).map(p => renderPostCard(p, profile, swarmId, events)).join('')
  const hasMore = posts.length > 5
    ? `<p class="see-all"><a href="public/posts/index.html">See all ${posts.length} posts →</a></p>`
    : ''

  const body = `
    <section class="profile-hero">
      <h1>${esc(name)}</h1>
      ${bio ? `<p class="profile-bio">${esc(bio)}</p>` : ''}
      ${websiteHtml}
      <div class="profile-stats">
        <span><strong>${posts.length}</strong> posts</span>
        <span><strong>${Math.max(0, followingCount)}</strong> following</span>
        <span><strong>${totalTipsReceived.toFixed(6)}</strong> XMR received</span>
      </div>
      <div class="profile-cta">
        <a class="btn-primary" href="${esc(SITE_URL)}" target="_blank" rel="noopener">Follow in Swarmnero</a>
      </div>
      <p class="swarm-id">Swarm ID: <code>${esc(swarmId || '')}</code></p>
    </section>

    <section class="recent-posts">
      <h2>Recent posts</h2>
      ${recent || '<p class="empty">No public posts yet.</p>'}
      ${hasMore}
    </section>
  `

  return pageShell({ title: name + ' — Swarmnero profile', body, swarmId })
}

function generatePostsIndexHtml(profile, posts, swarmId, events) {
  const name = profile.name || 'Swarmnero user'
  const list = posts.map(p => renderPostCard(p, profile, swarmId, events)).join('')
  const body = `
    <nav class="crumbs"><a href="index.html">← ${esc(name)}</a></nav>
    <h1>All posts</h1>
    <p class="muted">${posts.length} post${posts.length === 1 ? '' : 's'}</p>
    <section class="post-list">
      ${list || '<p class="empty">No public posts yet.</p>'}
    </section>
  `
  return pageShell({ title: name + ' — All posts', body, swarmId })
}

function generatePostHtml(post, profile, swarmId, events) {
  const name = profile.name || 'Swarmnero user'
  const paywall = isPaywalledPost(post)
  const counts = getInteractionCounts(events, post.pubkey, post.timestamp)
  const body = `
    <nav class="crumbs"><a href="index.html">← ${esc(name)}</a> · <a href="public/posts/index.html">All posts</a></nav>
    <article class="post single-post">
      <header class="post-header">
        <span class="post-author">${esc(name)}</span>
        <time class="post-time">${esc(formatTime(post.timestamp))}</time>
      </header>
      ${paywall
        ? renderPaywallBody(post)
        : `<div class="post-body">${esc(post.content || '')}</div>`}
      ${renderInteractionRow(counts, post)}
    </article>
  `
  return pageShell({
    title: (post.content ? String(post.content).slice(0, 60) : 'Post') + ' — ' + name,
    body,
    swarmId
  })
}

function renderPostCard(post, profile, swarmId, events) {
  const paywall = isPaywalledPost(post)
  const counts = getInteractionCounts(events, post.pubkey, post.timestamp)
  const bodyHtml = paywall
    ? renderPaywallBody(post)
    : `<div class="post-body">${esc(post.content || '')}</div>`

  return `
    <article class="post post-card">
      <header class="post-header">
        <time class="post-time">${esc(formatTime(post.timestamp))}</time>
      </header>
      ${bodyHtml}
      ${renderInteractionRow(counts, post)}
      <footer class="post-footer">
        <a href="public/posts/${esc(String(post.timestamp))}.html">Permalink →</a>
      </footer>
    </article>
  `
}

function renderPaywallBody(post) {
  const price = post.paywall_price || '?'
  const preview = post.paywall_preview || ''
  return `
    <div class="paywall">
      <div class="paywall-label">🔒 Paywalled post — ${esc(price)} XMR</div>
      ${preview ? `<div class="paywall-preview">${esc(preview)}</div>` : ''}
      <a class="btn-secondary" href="${esc(SITE_URL)}" target="_blank" rel="noopener">Unlock in Swarmnero</a>
    </div>
  `
}

function renderInteractionRow(counts, post) {
  const parts = []
  if (counts.likes) parts.push(`${counts.likes} like${counts.likes === 1 ? '' : 's'}`)
  if (counts.reposts) parts.push(`${counts.reposts} repost${counts.reposts === 1 ? '' : 's'}`)
  if (counts.replies) parts.push(`${counts.replies} repl${counts.replies === 1 ? 'y' : 'ies'}`)
  if (counts.tips) parts.push(`${counts.tips} tip${counts.tips === 1 ? '' : 's'}`)
  if (parts.length === 0) return ''
  return `<div class="interactions"><small>${parts.join(' · ')} <span class="publisher-view">(publisher view)</span></small></div>`
}

function generateCSS() {
  return `:root {
  --bg: #0d1117;
  --bg-alt: #161b22;
  --text: #e6edf3;
  --dim: #8b949e;
  --accent: #ff6600;
  --border: #30363d;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 720px; margin: 0 auto; padding: 0 20px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg-alt); padding: 2px 6px; border-radius: 4px; }
.site-header {
  padding: 16px 0;
  border-bottom: 1px solid var(--border);
  background: rgba(13, 17, 23, 0.92);
}
.site-header .wrap { display: flex; align-items: center; justify-content: space-between; }
.brand { color: var(--text); font-weight: 600; }
.install-cta {
  background: var(--accent); color: #0d1117;
  padding: 6px 14px; border-radius: 6px; font-size: 14px; font-weight: 500;
}
.install-cta:hover { text-decoration: none; filter: brightness(1.1); }
main.wrap { padding-top: 32px; padding-bottom: 80px; }
.profile-hero { text-align: center; padding: 30px 0 40px; }
.profile-hero h1 { font-size: 32px; margin-bottom: 12px; }
.profile-bio { color: var(--dim); margin-bottom: 8px; max-width: 480px; margin-left: auto; margin-right: auto; }
.profile-website { margin-bottom: 16px; }
.profile-stats {
  display: flex; justify-content: center; gap: 24px; margin-top: 20px;
  color: var(--dim); font-size: 14px;
}
.profile-stats strong { color: var(--text); font-weight: 600; }
.profile-cta { margin-top: 24px; }
.btn-primary, .btn-secondary {
  display: inline-block; padding: 8px 18px; border-radius: 6px;
  font-weight: 500; font-size: 14px;
}
.btn-primary { background: var(--accent); color: #0d1117; }
.btn-primary:hover { filter: brightness(1.1); text-decoration: none; }
.btn-secondary {
  background: var(--bg-alt); color: var(--text);
  border: 1px solid var(--border);
}
.btn-secondary:hover { border-color: var(--accent); text-decoration: none; }
.swarm-id { margin-top: 24px; color: var(--dim); font-size: 12px; word-break: break-all; }
.swarm-id code { font-size: 11px; }
.recent-posts { margin-top: 40px; }
.recent-posts h2 { font-size: 20px; margin-bottom: 20px; color: var(--dim); font-weight: 600; }
.post, .post-card {
  border: 1px solid var(--border); border-radius: 8px;
  padding: 16px; margin-bottom: 16px; background: var(--bg-alt);
}
.post-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.post-author { font-weight: 600; color: var(--accent); }
.post-time { color: var(--dim); font-size: 13px; }
.post-body { white-space: pre-wrap; word-wrap: break-word; }
.post-footer { margin-top: 12px; font-size: 13px; }
.single-post .post-body { font-size: 16px; line-height: 1.7; }
.paywall { padding: 16px; background: rgba(255, 102, 0, 0.05); border: 1px solid var(--accent); border-radius: 6px; }
.paywall-label { color: var(--accent); font-weight: 600; margin-bottom: 10px; }
.paywall-preview { color: var(--dim); margin-bottom: 12px; white-space: pre-wrap; }
.interactions { margin-top: 10px; color: var(--dim); font-size: 13px; }
.publisher-view { opacity: 0.7; font-style: italic; }
.crumbs { margin-bottom: 24px; font-size: 13px; }
.empty { color: var(--dim); text-align: center; padding: 40px 0; }
.see-all { text-align: center; margin-top: 20px; }
.muted { color: var(--dim); }
.site-footer { border-top: 1px solid var(--border); padding: 20px 0; margin-top: 40px; }
.footer-small { color: var(--dim); font-size: 12px; margin-bottom: 4px; word-break: break-all; }
`
}
