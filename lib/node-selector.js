/**
 * Swarmnero Node Selector - Automatic fastest Monero node selection
 *
 * Tests all configured Monero nodes for latency and selects the fastest one.
 * Uses get_height RPC call to measure response time.
 */

import moneroTs from 'monero-ts'

// Default remote nodes for mainnet
const DEFAULT_NODES = [
  'https://node.sethforprivacy.com:443',
  'https://xmr-node.cakewallet.com:18081',
  'https://node.community.rino.io:18081',
  'https://nodes.hashvault.pro:18081',
  // Additional fallback nodes for improved reliability
  'https://xmr.0xrpc.io:443',
  'https://public-monero-node.xyz:443',
  'https://kowalski.fiatfaucet.com:443',
  'https://xmr.europeanmonero.observer:443',
  'https://xmr.ci.vet:443',
  'https://xmr.thinhhv.com:443'
]

// Selected node state
let selectedNode = null
let selectedNodeLatency = null

/**
 * Test a single node's latency using get_height RPC call
 * @param {string} nodeUrl - Node URL to test
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{url: string, latency: number, height: number}|null>}
 */
export async function testNodeLatency(nodeUrl, timeoutMs = 5000) {
  const startTime = Date.now()

  try {
    // Create a promise that rejects after timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    })

    // Create the test promise
    const testPromise = (async () => {
      const daemon = await moneroTs.connectToDaemonRpc(nodeUrl)
      const height = await daemon.getHeight()
      return height
    })()

    // Race between test and timeout
    const height = await Promise.race([testPromise, timeoutPromise])
    const latency = Date.now() - startTime

    console.log(`[NodeSelector] ${nodeUrl} - ${latency}ms (height: ${height})`)

    return {
      url: nodeUrl,
      latency,
      height
    }
  } catch (e) {
    console.warn(`[NodeSelector] ${nodeUrl} - Failed: ${e.message}`)
    return null
  }
}

/**
 * Test all nodes in parallel and return results sorted by speed
 * @param {string[]} nodeUrls - Array of node URLs to test
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Array<{url: string, latency: number, height: number}>>}
 */
export async function testAllNodes(nodeUrls = DEFAULT_NODES, timeoutMs = 5000) {
  console.log('[NodeSelector] Testing', nodeUrls.length, 'nodes...')

  // Test all nodes in parallel
  const results = await Promise.all(
    nodeUrls.map(url => testNodeLatency(url, timeoutMs))
  )

  // Filter out failed nodes and sort by latency
  const validResults = results
    .filter(r => r !== null)
    .sort((a, b) => a.latency - b.latency)

  console.log('[NodeSelector] Working nodes:', validResults.length)

  return validResults
}

/**
 * Select the fastest working node
 * @param {string[]} nodeUrls - Array of node URLs to test
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<{url: string, latency: number, height: number}|null>}
 */
export async function selectFastestNode(nodeUrls = DEFAULT_NODES, timeoutMs = 5000) {
  const results = await testAllNodes(nodeUrls, timeoutMs)

  if (results.length === 0) {
    console.error('[NodeSelector] No working nodes found!')
    selectedNode = null
    selectedNodeLatency = null
    return null
  }

  const fastest = results[0]
  selectedNode = fastest.url
  selectedNodeLatency = fastest.latency

  console.log(`[NodeSelector] Selected: ${fastest.url} (${fastest.latency}ms)`)

  return fastest
}

/**
 * Get the current node list
 * @returns {string[]} Array of node URLs
 */
export function getNodeList() {
  return [...DEFAULT_NODES]
}

/**
 * Get the currently selected node
 * @returns {{url: string, latency: number}|null}
 */
export function getSelectedNode() {
  if (!selectedNode) {
    return null
  }
  return {
    url: selectedNode,
    latency: selectedNodeLatency
  }
}

/**
 * Clear selected node (forces re-selection on next request)
 */
export function clearSelectedNode() {
  selectedNode = null
  selectedNodeLatency = null
  console.log('[NodeSelector] Cleared selected node')
}
