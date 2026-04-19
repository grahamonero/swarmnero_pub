/**
 * Price Oracle - XMR/USD price with provider fallback and cache
 *
 * Primary: CoinGecko
 * Backup:  Kraken public ticker
 *
 * Refreshes every REFRESH_MS. Falls back to cache if both providers fail.
 * Throws if cache is older than STALE_CUTOFF_MS.
 */

import https from 'https'

const REFRESH_MS = 5 * 60 * 1000       // 5 minutes
const STALE_CUTOFF_MS = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT_MS = 5000
const DIVERGENCE_WARN_PCT = 10         // warn if providers disagree by >10%

const ATOMIC_PER_XMR = 1_000_000_000_000n // 1 XMR = 1e12 piconero

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'swarmnero-sync/1.0' }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (err) {
          reject(new Error('Invalid JSON'))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
  })
}

async function fetchCoinGecko() {
  const json = await httpsGetJson('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd')
  const price = json?.monero?.usd
  if (typeof price !== 'number' || price <= 0) throw new Error('Bad CoinGecko payload')
  return price
}

async function fetchKraken() {
  const json = await httpsGetJson('https://api.kraken.com/0/public/Ticker?pair=XMRUSD')
  if (json?.error?.length) throw new Error('Kraken error: ' + json.error.join(','))
  const result = json?.result
  if (!result) throw new Error('Bad Kraken payload')
  // Kraken returns the pair under its internal name (e.g. XXMRZUSD)
  const key = Object.keys(result)[0]
  const last = parseFloat(result[key]?.c?.[0])
  if (!Number.isFinite(last) || last <= 0) throw new Error('Bad Kraken price')
  return last
}

export class PriceOracle {
  constructor() {
    this._cached = null        // { price, fetchedAt, source }
    this._refreshTimer = null
    this._refreshing = null    // in-flight promise
  }

  async init() {
    await this._refresh()
    this._refreshTimer = setInterval(() => {
      this._refresh().catch(err => {
        console.warn('[PriceOracle] Scheduled refresh failed:', err.message)
      })
    }, REFRESH_MS)
  }

  async _refresh() {
    if (this._refreshing) return this._refreshing
    this._refreshing = (async () => {
      let primary = null
      let backup = null

      try { primary = await fetchCoinGecko() } catch (err) {
        console.warn('[PriceOracle] CoinGecko failed:', err.message)
      }
      try { backup = await fetchKraken() } catch (err) {
        console.warn('[PriceOracle] Kraken failed:', err.message)
      }

      if (primary != null && backup != null) {
        const diffPct = Math.abs(primary - backup) / Math.min(primary, backup) * 100
        if (diffPct > DIVERGENCE_WARN_PCT) {
          console.warn(`[PriceOracle] Providers diverge by ${diffPct.toFixed(1)}%: CoinGecko=${primary} Kraken=${backup}`)
        }
      }

      const chosen = primary ?? backup
      if (chosen != null) {
        this._cached = {
          price: chosen,
          fetchedAt: Date.now(),
          source: primary != null ? 'coingecko' : 'kraken'
        }
        console.log(`[PriceOracle] XMR/USD = ${chosen} (${this._cached.source})`)
        return chosen
      }

      // Both failed — keep existing cache, caller decides if it's still valid
      if (this._cached) {
        console.warn('[PriceOracle] All providers failed, keeping cache from', new Date(this._cached.fetchedAt).toISOString())
        return this._cached.price
      }

      throw new Error('All price providers failed and no cache available')
    })()

    try {
      return await this._refreshing
    } finally {
      this._refreshing = null
    }
  }

  /**
   * Get current XMR/USD price. Returns cached if within STALE_CUTOFF_MS.
   * Throws if no usable price.
   */
  async getUsdPrice() {
    if (this._cached && (Date.now() - this._cached.fetchedAt) < STALE_CUTOFF_MS) {
      return this._cached.price
    }
    await this._refresh()
    if (!this._cached || (Date.now() - this._cached.fetchedAt) >= STALE_CUTOFF_MS) {
      throw new Error('Price oracle unavailable — try again later')
    }
    return this._cached.price
  }

  /**
   * Convert a USD amount to atomic XMR units (piconero) at current price.
   * @param {number} usd - USD amount
   * @returns {Promise<bigint>} atomic units
   */
  async atomicForUsd(usd) {
    const price = await this.getUsdPrice()
    const xmr = usd / price
    // Use BigInt for atomic unit precision
    const atomic = BigInt(Math.round(xmr * Number(ATOMIC_PER_XMR)))
    return atomic
  }

  close() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }
  }
}

export { ATOMIC_PER_XMR }
