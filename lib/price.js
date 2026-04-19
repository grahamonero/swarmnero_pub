// XMR/USD price fetching with caching

const PRICE_CACHE_MS = 5 * 60 * 1000 // 5 minute cache
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd'
const ATOMIC_UNITS_PER_XMR = 1e12

let cachedPrice = null
let cacheTimestamp = 0

export async function getXMRPrice() {
  const now = Date.now()

  // Return cached price if still valid
  if (cachedPrice !== null && (now - cacheTimestamp) < PRICE_CACHE_MS) {
    return cachedPrice
  }

  try {
    const response = await fetch(COINGECKO_URL)
    if (!response.ok) {
      console.warn('[Price] HTTP error:', response.status)
      return cachedPrice
    }

    const data = await response.json()
    const price = data?.monero?.usd

    if (typeof price !== 'number') {
      return cachedPrice
    }

    cachedPrice = price
    cacheTimestamp = now
    return price
  } catch (e) {
    // Silently fail - price display is optional
    return cachedPrice
  }
}

export function formatUSD(xmrAmount, price) {
  if (price === null || price === undefined) {
    return ''
  }

  // Use Math.abs to ensure USD is always displayed as positive
  // The XMR amount itself handles the sign display
  const usdValue = Math.abs(xmrAmount * price)
  return `~$${usdValue.toFixed(2)}`
}

export function formatXMRWithUSD(atomicUnits, price) {
  const xmrAmount = Number(atomicUnits) / ATOMIC_UNITS_PER_XMR
  const xmrStr = xmrAmount.toFixed(8) + ' XMR'
  const usdStr = formatUSD(xmrAmount, price)

  if (usdStr) {
    return `${xmrStr} (${usdStr})`
  }
  return xmrStr
}
