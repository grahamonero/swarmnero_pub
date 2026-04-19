/**
 * Simple QR Code Generator
 * Generates QR codes on canvas elements without external dependencies
 * Supports encoding Monero addresses (95-106 characters)
 * Uses Error Correction Level L for simplicity
 */

// QR Code constants
const MODE_BYTE = 0b0100;
const EC_LEVEL_L = 0;

// Version capacities for byte mode with EC level L
// Each entry is max bytes for that version
const VERSION_CAPACITY_L = [
  0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271,
  321, 367, 425, 458, 520, 586, 644, 718, 792, 858
];

// Error correction codewords per block for EC level L
const EC_CODEWORDS_L = [
  0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
  20, 24, 26, 30, 22, 24, 28, 30, 28, 28
];

// Number of error correction blocks for EC level L
const EC_BLOCKS_L = [
  0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4,
  4, 4, 4, 4, 6, 6, 6, 6, 7, 8
];

// Generator polynomials for Reed-Solomon (precomputed)
const GEN_POLYNOMIALS = {};

// Galois field tables
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);

// Initialize Galois field tables
function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x *= 2;
    if (x >= 256) {
      x ^= 0x11d; // QR code uses polynomial x^8 + x^4 + x^3 + x^2 + 1
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

initGaloisField();

// Galois field multiplication
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// Generate Reed-Solomon generator polynomial
function getGeneratorPolynomial(degree) {
  if (GEN_POLYNOMIALS[degree]) return GEN_POLYNOMIALS[degree];

  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const newPoly = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      newPoly[j] ^= poly[j];
      newPoly[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = newPoly;
  }

  GEN_POLYNOMIALS[degree] = poly;
  return poly;
}

// Calculate Reed-Solomon error correction codewords
function rsEncode(data, ecCount) {
  const gen = getGeneratorPolynomial(ecCount);
  const result = new Array(ecCount).fill(0);

  for (let i = 0; i < data.length; i++) {
    const coef = data[i] ^ result[0];
    result.shift();
    result.push(0);
    for (let j = 0; j < ecCount; j++) {
      result[j] ^= gfMul(coef, gen[j + 1]);
    }
  }

  return result;
}

// Determine QR version needed for data length
function getVersion(dataLength) {
  for (let v = 1; v <= 20; v++) {
    if (VERSION_CAPACITY_L[v] >= dataLength) {
      return v;
    }
  }
  throw new Error('Data too long for QR code');
}

// Get QR code size (modules per side)
function getSize(version) {
  return 17 + version * 4;
}

// Encode data into bit stream
function encodeData(text, version) {
  const data = [];
  const bytes = new TextEncoder().encode(text);

  // Mode indicator (4 bits for byte mode)
  data.push(MODE_BYTE);

  // Character count indicator
  const countBits = version <= 9 ? 8 : 16;
  data.push({ value: bytes.length, bits: countBits });

  // Data bytes
  for (const byte of bytes) {
    data.push({ value: byte, bits: 8 });
  }

  // Calculate total data codewords available
  const totalModules = getSize(version) ** 2;
  const funcPatternModules =
    3 * 64 + // finder patterns
    2 * (getSize(version) - 16) + // timing patterns
    25 + // dark module + format info
    (version >= 7 ? 36 : 0); // version info

  const totalCodewords = Math.floor((totalModules - funcPatternModules) / 8);
  const ecCodewords = EC_CODEWORDS_L[version] * EC_BLOCKS_L[version];
  const dataCodewords = totalCodewords - ecCodewords;

  // Convert to bit string
  let bitString = '';
  for (const item of data) {
    if (typeof item === 'number') {
      bitString += item.toString(2).padStart(4, '0');
    } else {
      bitString += item.value.toString(2).padStart(item.bits, '0');
    }
  }

  // Add terminator
  const remainingBits = dataCodewords * 8 - bitString.length;
  if (remainingBits > 0) {
    bitString += '0'.repeat(Math.min(4, remainingBits));
  }

  // Pad to byte boundary
  while (bitString.length % 8 !== 0) {
    bitString += '0';
  }

  // Add pad codewords
  const padCodewords = ['11101100', '00010001'];
  let padIndex = 0;
  while (bitString.length < dataCodewords * 8) {
    bitString += padCodewords[padIndex % 2];
    padIndex++;
  }

  // Convert to bytes
  const codewords = [];
  for (let i = 0; i < bitString.length; i += 8) {
    codewords.push(parseInt(bitString.substr(i, 8), 2));
  }

  return codewords;
}

// Interleave data and error correction codewords
function interleaveCodewords(dataCodewords, version) {
  const numBlocks = EC_BLOCKS_L[version];
  const ecPerBlock = EC_CODEWORDS_L[version];
  const totalDataCodewords = dataCodewords.length;

  // Split data into blocks
  const blockSize = Math.floor(totalDataCodewords / numBlocks);
  const largerBlocks = totalDataCodewords % numBlocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < numBlocks; i++) {
    const size = blockSize + (i >= numBlocks - largerBlocks ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + size);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += size;
  }

  // Interleave data codewords
  const result = [];
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        result.push(block[i]);
      }
    }
  }

  // Interleave EC codewords
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      result.push(block[i]);
    }
  }

  return result;
}

// Create QR code matrix
function createMatrix(version) {
  const size = getSize(version);
  const matrix = Array(size).fill(null).map(() => Array(size).fill(null));
  return matrix;
}

// Add finder pattern at position
function addFinderPattern(matrix, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r;
      const mc = col + c;
      if (mr < 0 || mc < 0 || mr >= matrix.length || mc >= matrix.length) continue;

      if (r === -1 || r === 7 || c === -1 || c === 7) {
        matrix[mr][mc] = 0; // white separator
      } else if (r === 0 || r === 6 || c === 0 || c === 6) {
        matrix[mr][mc] = 1; // black border
      } else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) {
        matrix[mr][mc] = 1; // black center
      } else {
        matrix[mr][mc] = 0; // white
      }
    }
  }
}

// Add alignment pattern at position
function addAlignmentPattern(matrix, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const mr = row + r;
      const mc = col + c;
      if (matrix[mr][mc] !== null) continue;

      if (r === -2 || r === 2 || c === -2 || c === 2) {
        matrix[mr][mc] = 1;
      } else if (r === 0 && c === 0) {
        matrix[mr][mc] = 1;
      } else {
        matrix[mr][mc] = 0;
      }
    }
  }
}

// Get alignment pattern positions for version
function getAlignmentPositions(version) {
  if (version === 1) return [];

  const positions = [6];
  const size = getSize(version);
  const last = size - 7;

  if (version >= 2) {
    const step = Math.floor((last - 6) / Math.floor(version / 7 + 1));
    const count = Math.floor(version / 7) + 2;

    for (let i = 1; i < count; i++) {
      positions.push(last - (count - 1 - i) * step);
    }
  }

  return positions;
}

// Add timing patterns
function addTimingPatterns(matrix) {
  const size = matrix.length;
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === null) matrix[6][i] = bit;
    if (matrix[i][6] === null) matrix[i][6] = bit;
  }
}

// Add dark module and reserved areas
function addFixedPatterns(matrix, version) {
  const size = matrix.length;

  // Dark module
  matrix[size - 8][8] = 1;

  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === null) matrix[8][i] = 0;
    if (matrix[i][8] === null) matrix[i][8] = 0;
    if (i < 8 && matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = 0;
    if (i < 8 && matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = 0;
  }
}

// Place data bits in matrix
function placeData(matrix, data) {
  const size = matrix.length;
  let bitIndex = 0;
  const bits = data.flatMap(byte =>
    Array(8).fill(0).map((_, i) => (byte >> (7 - i)) & 1)
  );

  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // Skip timing pattern column

    for (let row = up ? size - 1 : 0; up ? row >= 0 : row < size; row += up ? -1 : 1) {
      for (let c = 0; c < 2; c++) {
        const actualCol = col - c;
        if (matrix[row][actualCol] === null) {
          matrix[row][actualCol] = bitIndex < bits.length ? bits[bitIndex] : 0;
          bitIndex++;
        }
      }
    }
    up = !up;
  }
}

// Apply mask pattern
function applyMask(matrix, maskNum) {
  const size = matrix.length;
  const masked = matrix.map(row => [...row]);

  const maskFunctions = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  const shouldMask = maskFunctions[maskNum];

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      // Only mask data areas (we marked function patterns already)
      if (isDataArea(row, col, size) && shouldMask(row, col)) {
        masked[row][col] ^= 1;
      }
    }
  }

  return masked;
}

// Check if position is in data area (not function pattern)
function isDataArea(row, col, size) {
  // Finder patterns + separators
  if (row < 9 && col < 9) return false;
  if (row < 9 && col >= size - 8) return false;
  if (row >= size - 8 && col < 9) return false;

  // Timing patterns
  if (row === 6 || col === 6) return false;

  return true;
}

// Calculate penalty score for mask selection
function calculatePenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;

  // Rule 1: consecutive modules in row/column
  for (let row = 0; row < size; row++) {
    let count = 1;
    for (let col = 1; col < size; col++) {
      if (matrix[row][col] === matrix[row][col - 1]) {
        count++;
      } else {
        if (count >= 5) penalty += 3 + (count - 5);
        count = 1;
      }
    }
    if (count >= 5) penalty += 3 + (count - 5);
  }

  for (let col = 0; col < size; col++) {
    let count = 1;
    for (let row = 1; row < size; row++) {
      if (matrix[row][col] === matrix[row - 1][col]) {
        count++;
      } else {
        if (count >= 5) penalty += 3 + (count - 5);
        count = 1;
      }
    }
    if (count >= 5) penalty += 3 + (count - 5);
  }

  // Rule 2: 2x2 blocks
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const val = matrix[row][col];
      if (val === matrix[row][col + 1] &&
          val === matrix[row + 1][col] &&
          val === matrix[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }

  return penalty;
}

// Add format information
function addFormatInfo(matrix, maskNum) {
  const size = matrix.length;

  // Format info for EC level L and mask
  const formatBits = EC_LEVEL_L << 3 | maskNum;

  // BCH encode format info
  let data = formatBits << 10;
  const generator = 0b10100110111;

  for (let i = 4; i >= 0; i--) {
    if (data & (1 << (i + 10))) {
      data ^= generator << i;
    }
  }

  const encoded = ((formatBits << 10) | data) ^ 0b101010000010010;

  // Place format info
  const formatPositions = [
    // Around top-left finder
    [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
     [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]],
    // Around other finders
    [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
     [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]]
  ];

  for (let i = 0; i < 15; i++) {
    const bit = (encoded >> i) & 1;
    const [r1, c1] = formatPositions[0][i];
    const [r2, c2] = formatPositions[1][i];
    matrix[r1][c1] = bit;
    matrix[r2][c2] = bit;
  }
}

// Main function to generate QR code
function generateQRMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = getVersion(bytes.length);

  // Encode data
  const dataCodewords = encodeData(text, version);
  const allCodewords = interleaveCodewords(dataCodewords, version);

  // Create matrix with function patterns
  const matrix = createMatrix(version);

  // Add finder patterns
  addFinderPattern(matrix, 0, 0);
  addFinderPattern(matrix, 0, matrix.length - 7);
  addFinderPattern(matrix, matrix.length - 7, 0);

  // Add alignment patterns
  const alignPos = getAlignmentPositions(version);
  for (const row of alignPos) {
    for (const col of alignPos) {
      // Skip if overlapping with finder patterns
      if ((row < 9 && col < 9) ||
          (row < 9 && col >= matrix.length - 9) ||
          (row >= matrix.length - 9 && col < 9)) {
        continue;
      }
      addAlignmentPattern(matrix, row, col);
    }
  }

  // Add timing patterns
  addTimingPatterns(matrix);

  // Add fixed patterns
  addFixedPatterns(matrix, version);

  // Place data
  placeData(matrix, allCodewords);

  // Find best mask
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(matrix, mask);
    addFormatInfo(masked, mask);
    const penalty = calculatePenalty(masked);

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestMatrix = masked;
    }
  }

  return bestMatrix;
}

// Render QR code to canvas
export function generateQRCode(canvas, text, size) {
  const matrix = generateQRMatrix(text);
  const ctx = canvas.getContext('2d');

  // Calculate module size with quiet zone
  // Use integer module size to prevent blurry subpixel rendering
  const quietZone = 4;
  const matrixSize = matrix.length + quietZone * 2;
  const moduleSize = Math.floor(size / matrixSize);

  // Adjust canvas size to fit integer modules exactly
  // This ensures crisp edges for better QR code scanning
  const actualSize = moduleSize * matrixSize;
  canvas.width = actualSize;
  canvas.height = actualSize;

  // Disable image smoothing for sharp pixel edges
  ctx.imageSmoothingEnabled = false;

  // Fill white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, actualSize, actualSize);

  // Draw modules with integer pixel coordinates
  ctx.fillStyle = '#000000';
  for (let row = 0; row < matrix.length; row++) {
    for (let col = 0; col < matrix.length; col++) {
      if (matrix[row][col]) {
        ctx.fillRect(
          (col + quietZone) * moduleSize,
          (row + quietZone) * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }
}
