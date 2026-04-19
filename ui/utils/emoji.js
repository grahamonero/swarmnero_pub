/**
 * Emoji picker functionality
 */

import { insertAtCursor } from './dom.js'

/**
 * Common emojis for the picker
 */
export const emojis = [
  '😀', '😂', '😍', '🤔', '👍', '👎', '❤️', '🔥',
  '✨', '🎉', '🙌', '💪', '🤝', '👀', '💡', '🚀',
  '💰', '🪙', '🔒', '🌐', '⚡', '🎯', '✅', '❌',
  '📢', '💬', '🔗', '📝', '🛠️', '⚙️', '📊', '🏆'
]

/**
 * Initialize emoji picker with buttons
 * Can be called two ways:
 * 1. initEmojiPicker(emojiGrid, emojiPicker, postContentEl, updateCharCount) - original
 * 2. initEmojiPicker(emojiGrid, onSelect) - simplified for inline forms
 */
export function initEmojiPicker(emojiGrid, emojiPickerOrCallback, postContentEl, updateCharCount) {
  // Check if called with simplified signature (2 args, second is callback)
  const isSimplified = typeof emojiPickerOrCallback === 'function'

  // Populate grid with emoji buttons
  emojis.forEach(emoji => {
    const btn = document.createElement('button')
    btn.className = 'emoji-btn'
    btn.textContent = emoji
    btn.type = 'button'
    btn.addEventListener('click', () => {
      if (isSimplified) {
        // Simplified mode: call the callback with emoji
        emojiPickerOrCallback(emoji)
      } else {
        // Original mode: insert into element and hide picker
        insertAtCursor(postContentEl, emoji)
        emojiPickerOrCallback.classList.remove('show')
        if (updateCharCount) updateCharCount()
      }
    })
    emojiGrid.appendChild(btn)
  })

  // Close emoji picker when clicking outside (only for original mode)
  if (!isSimplified && emojiPickerOrCallback) {
    document.addEventListener('click', () => {
      if (emojiPickerOrCallback && emojiPickerOrCallback.classList) {
        emojiPickerOrCallback.classList.remove('show')
      }
    })
  }
}

/**
 * Toggle emoji picker visibility
 */
export function toggleEmojiPicker(emojiPicker, e) {
  e.stopPropagation()
  emojiPicker.classList.toggle('show')
}
