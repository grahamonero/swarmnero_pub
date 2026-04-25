#!/usr/bin/env node
// Smoke tests for multi-image carousel feature.
//
// Runs with plain node — no test framework in the project.
//   node scripts/test-carousel.mjs
//
// Covers what runs outside the browser:
//   - MAX_MEDIA_PER_POST cap at compose time
//   - sanitizeMediaArray rejects malformed / oversize / unsafe-path entries
//   - createPostEvent / createReplyEvent truncate to cap
//
// The EXIF stripper (lib/media.js stripImageExif) runs in the DOM through
// <canvas>.toBlob, so it cannot be exercised from Node without jsdom +
// canvas shims. Manual browser smoke test for the 3-image EXIF assertion
// is documented at the bottom of this file.

import {
  MAX_MEDIA_PER_POST,
  sanitizeMediaArray,
  createPostEvent,
  createReplyEvent
} from '../lib/events.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('  ok -', msg)
  } else {
    failures++
    console.error('  FAIL -', msg)
  }
}

const HEX64 = 'a'.repeat(64)

function validItem(i = 0) {
  return {
    driveKey: HEX64,
    path: `/images/${1000 + i}.jpg`,
    mimeType: 'image/jpeg',
    size: 1024,
    exifStripped: true
  }
}

console.log('sanitizeMediaArray')
assert(sanitizeMediaArray(null).length === 0, 'null input -> []')
assert(sanitizeMediaArray('nope').length === 0, 'non-array input -> []')
assert(sanitizeMediaArray([validItem()]).length === 1, 'one valid item kept')

// Cap at 10
const twenty = Array.from({ length: 20 }, (_, i) => validItem(i))
const capped = sanitizeMediaArray(twenty)
assert(capped.length === MAX_MEDIA_PER_POST, `20 items truncate to ${MAX_MEDIA_PER_POST}`)

// Reject bad driveKey
assert(
  sanitizeMediaArray([{ ...validItem(), driveKey: 'zz' }]).length === 0,
  'invalid driveKey rejected'
)

// Reject path outside allow-list
assert(
  sanitizeMediaArray([{ ...validItem(), path: '/etc/passwd' }]).length === 0,
  'path outside /images/ /videos/ /files/ rejected'
)
assert(
  sanitizeMediaArray([{ ...validItem(), path: '/images/../../etc/passwd' }]).length === 0,
  'path traversal rejected'
)
assert(
  sanitizeMediaArray([{ ...validItem(), path: '/images/ok\u0000.jpg' }]).length === 0,
  'null byte in path rejected'
)

// Reject oversize
assert(
  sanitizeMediaArray([{ ...validItem(), size: 26 * 1024 * 1024 }]).length === 0,
  'oversize (>25 MB) rejected'
)

// Reject bad thumb shape
assert(
  sanitizeMediaArray([{ ...validItem(), thumb: 'javascript:alert(1)' }]).length === 0,
  'non-data-url thumb rejected'
)
assert(
  sanitizeMediaArray([{ ...validItem(), thumb: 'data:image/png;base64,AAA' }]).length === 1,
  'data:image/... thumb accepted'
)

// Mix valid + junk -> keep only valid, in order, until cap hit
const mixed = [
  validItem(0),
  { driveKey: 'bad' },
  validItem(1),
  null,
  validItem(2),
  { ...validItem(3), path: '../escape' }
]
const filtered = sanitizeMediaArray(mixed)
assert(filtered.length === 3, 'mixed input keeps 3 valid items')
assert(
  filtered[0].path === '/images/1000.jpg' &&
  filtered[1].path === '/images/1001.jpg' &&
  filtered[2].path === '/images/1002.jpg',
  'valid items preserved in order'
)

console.log('createPostEvent / createReplyEvent cap')
const pe = createPostEvent({ content: 'x', media: twenty })
assert(pe.media.length === MAX_MEDIA_PER_POST, `post event media capped to ${MAX_MEDIA_PER_POST}`)

const re = createReplyEvent({ toPubkey: 'a', postTimestamp: 1, content: 'x', media: twenty })
assert(re.media.length === MAX_MEDIA_PER_POST, `reply event media capped to ${MAX_MEDIA_PER_POST}`)

const peMissing = createPostEvent({ content: 'x' })
assert(Array.isArray(peMissing.media) && peMissing.media.length === 0, 'missing media -> []')

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll sanitize/cap checks passed.')

/*
  Manual browser smoke test — 3-image EXIF strip
  ----------------------------------------------
  The canvas-based EXIF stripper runs in the renderer (Pear) process, not
  Node. To verify that a 3-image post produces 3 stripped blobs with zero
  EXIF tags, follow these steps (one-time check any time stripImageExif
  changes):

  1.  Prepare three JPEGs that carry GPS + camera EXIF. Easy way:
         exiftool -GPSLatitude="37.7749" -GPSLongitude="-122.4194" \
                  -Make="TestCam" img1.jpg img2.jpg img3.jpg
      Confirm tags present:
         exiftool img1.jpg img2.jpg img3.jpg | grep -Ei 'gps|make'

  2.  Launch the app: `pear run --dev .`

  3.  Open the composer. Attach all three images via the media button.
      Confirm previews appear and delete-X renders for each. Post.

  4.  In the Pear DevTools console, dump the raw bytes for each stored
      image and pipe through exiftool:
         // In devtools:
         for (const m of lastPost.media) {
           const blob = await state.media.drive.get(m.path)
           await navigator.clipboard.writeText(
             btoa(String.fromCharCode(...new Uint8Array(blob))))
         }
      Paste each base64 blob into a file, decode, run `exiftool`. For
      every one of the three, the output must NOT contain GPSLatitude /
      GPSLongitude / Make / Model. The only tags present should be the
      baseline JFIF markers canvas.toBlob produces.

  5.  Verify the metadata `exifStripped: true` in each media descriptor:
         lastPost.media.every(m => m.exifStripped === true)  // -> true
*/
