/**
 * Column resize functionality for the three-column layout
 * Allows users to drag dividers to resize left and right columns
 */

const STORAGE_KEY = 'swarmnero_column_widths'
const MIN_COLUMN_WIDTH = 200
const MAX_COLUMN_WIDTH = 500
const DEFAULT_COLUMN_WIDTH = 340

// Track if column resize has been initialized (prevents duplicate event listeners)
let columnResizeInitialized = false

/**
 * Get saved column widths from localStorage
 */
function getSavedWidths() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.warn('[ColumnResize] Failed to load saved widths:', e)
  }
  return { left: DEFAULT_COLUMN_WIDTH, right: DEFAULT_COLUMN_WIDTH }
}

/**
 * Save column widths to localStorage
 */
function saveWidths(widths) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths))
  } catch (e) {
    console.warn('[ColumnResize] Failed to save widths:', e)
  }
}

/**
 * Apply column widths to the grid layout
 * Grid has 5 columns: left, divider, center, divider, right
 */
function applyWidths(appLayout, widths, hasDividers = false) {
  if (hasDividers) {
    // With dividers: 5 columns (left, divider, center, divider, right)
    // Use explicit 16px for dividers to avoid grid layout issues
    appLayout.style.gridTemplateColumns = `${widths.left}px 16px 1fr 16px ${widths.right}px`
  } else {
    // Initial state: 3 columns (before dividers are inserted)
    appLayout.style.gridTemplateColumns = `${widths.left}px 1fr ${widths.right}px`
  }
}

/**
 * Constrain width to min/max bounds
 */
function constrainWidth(width) {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, width))
}

/**
 * Create a resize divider element
 */
function createDivider(side) {
  const divider = document.createElement('div')
  divider.className = `column-divider column-divider-${side}`
  divider.dataset.side = side

  // Create the handle inside the divider
  const handle = document.createElement('div')
  handle.className = 'column-divider-handle'
  divider.appendChild(handle)

  return divider
}

/**
 * Initialize column resize functionality
 */
export function initColumnResize() {
  // Skip if already initialized (prevents duplicate dividers and event listeners on re-login)
  if (columnResizeInitialized) {
    return
  }

  const appLayout = document.getElementById('appLayout')
  if (!appLayout) {
    console.warn('[ColumnResize] App layout not found')
    return
  }

  const leftColumn = appLayout.querySelector('.left-column')
  const centerColumn = appLayout.querySelector('.center-column')
  const rightPanel = appLayout.querySelector('.right-panel')

  if (!leftColumn || !centerColumn || !rightPanel) {
    console.warn('[ColumnResize] Columns not found')
    return
  }

  // Load saved widths
  const widths = getSavedWidths()

  // Check if dividers already exist (prevents duplicate dividers on re-login)
  let leftDivider = appLayout.querySelector('.column-divider-left')
  let rightDivider = appLayout.querySelector('.column-divider-right')

  if (!leftDivider || !rightDivider) {
    // Create and insert dividers only if they don't exist
    leftDivider = createDivider('left')
    rightDivider = createDivider('right')

    // Insert dividers after their respective columns
    leftColumn.after(leftDivider)
    centerColumn.after(rightDivider)
  }

  // Apply widths with dividers now in place
  applyWidths(appLayout, widths, true)

  // State for drag operations
  let isDragging = false
  let activeSide = null
  let startX = 0
  let startWidth = 0

  /**
   * Handle mouse down on divider
   */
  function onMouseDown(e) {
    // Only handle left mouse button
    if (e.button !== 0) return

    const divider = e.target.closest('.column-divider')
    if (!divider) return

    e.preventDefault()
    isDragging = true
    activeSide = divider.dataset.side
    startX = e.clientX
    startWidth = activeSide === 'left' ? widths.left : widths.right

    // Add dragging class for visual feedback
    divider.classList.add('dragging')
    document.body.classList.add('column-resizing')
  }

  /**
   * Handle mouse move during drag
   */
  function onMouseMove(e) {
    if (!isDragging) return

    e.preventDefault()
    const delta = e.clientX - startX

    if (activeSide === 'left') {
      // Left column: moving right increases width
      widths.left = constrainWidth(startWidth + delta)
    } else {
      // Right column: moving left increases width
      widths.right = constrainWidth(startWidth - delta)
    }

    applyWidths(appLayout, widths, true)
  }

  /**
   * Handle mouse up to end drag
   */
  function onMouseUp() {
    if (!isDragging) return

    isDragging = false

    // Remove dragging classes
    document.querySelectorAll('.column-divider.dragging').forEach(d => {
      d.classList.remove('dragging')
    })
    document.body.classList.remove('column-resizing')

    // Save the new widths
    saveWidths(widths)
    activeSide = null
  }

  // Attach event listeners
  leftDivider.addEventListener('mousedown', onMouseDown)
  rightDivider.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)

  // Handle mouse leaving the window during drag
  document.addEventListener('mouseleave', onMouseUp)

  // Double-click to reset to default width
  function onDoubleClick(e) {
    const divider = e.target.closest('.column-divider')
    if (!divider) return

    const side = divider.dataset.side
    widths[side] = DEFAULT_COLUMN_WIDTH
    applyWidths(appLayout, widths, true)
    saveWidths(widths)
  }

  leftDivider.addEventListener('dblclick', onDoubleClick)
  rightDivider.addEventListener('dblclick', onDoubleClick)

  columnResizeInitialized = true
  console.log('[ColumnResize] Initialized with widths:', widths)
}

/**
 * Reset column widths to defaults
 */
export function resetColumnWidths() {
  const appLayout = document.getElementById('appLayout')
  if (!appLayout) return

  const widths = { left: DEFAULT_COLUMN_WIDTH, right: DEFAULT_COLUMN_WIDTH }
  // Check if dividers exist
  const hasDividers = appLayout.querySelector('.column-divider') !== null
  applyWidths(appLayout, widths, hasDividers)
  saveWidths(widths)
}
