

const END_DELIMITER = '##END##';

//binary to text vice versa

function textToBinary(text) {
  let binary = '';
  for (let i = 0; i < text.length; i++) {
    // 8-bit binary representation of each character's char code
    binary += text.charCodeAt(i).toString(2).padStart(8, '0');
  }
  return binary;
}

function binaryToText(binary) {
  let text = '';
  for (let i = 0; i + 8 <= binary.length; i += 8) {
    text += String.fromCharCode(parseInt(binary.substr(i, 8), 2));
  }
  return text;
}

/* ---------- Encode ---------- */


 *
 * @param {HTMLCanvasElement} canvas - canvas already holding the source image
 * @param {string} secretText - message to hide
 * @returns {HTMLCanvasElement} the same canvas, now holding the encoded image
 */
function encodeMessage(canvas, secretText) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const binaryMessage = textToBinary(secretText + END_DELIMITER);

  // 3 usable channels per pixel (R, G, B) — alpha (every 4th byte) is skipped
  const usableChannels = Math.floor(data.length / 4) * 3;
  if (binaryMessage.length > usableChannels) {
    throw new Error(
      'Message is too long to fit in this image. Max ~' +
      Math.floor(usableChannels / 8) + ' characters for this canvas size.'
    );
  }

  let bitIndex = 0;
  for (let i = 0; i < data.length && bitIndex < binaryMessage.length; i += 4) {
    for (let channel = 0; channel < 3 && bitIndex < binaryMessage.length; channel++) {
      const bit = binaryMessage.charCodeAt(bitIndex) - 48; // '0' -> 0, '1' -> 1
      data[i + channel] = (data[i + channel] & 0xFE) | bit;
      bitIndex++;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/* ---------- Decode ---------- */

/**
 * Reads a message previously hidden with encodeMessage() out of `canvas`.
 *
 * @param {HTMLCanvasElement} canvas - canvas holding the encoded image
 * @returns {string|null} the decoded message, or null if no delimiter was found
 */
function decodeMessage(canvas) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const delimiterBinary = textToBinary(END_DELIMITER);
  let binary = '';

  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      binary += (data[i + channel] & 1);

      // Check for the delimiter only on whole-byte boundaries, and only
      // once we have at least as many bits as the delimiter itself.
      if (binary.length % 8 === 0 && binary.length >= delimiterBinary.length) {
        if (binary.slice(-delimiterBinary.length) === delimiterBinary) {
          return binaryToText(binary.slice(0, -delimiterBinary.length));
        }
      }
    }
  }

  // Ran out of pixels without ever finding the delimiter —
  // this image likely has no hidden message (or was corrupted).
  return null;
}

/* ---------- Difference map ---------- */

/**
 
 *
 * @param {HTMLCanvasElement} originalCanvas - canvas holding the pre-encode image
 * @param {HTMLCanvasElement} encodedCanvas - canvas holding the post-encode image
 * @param {HTMLCanvasElement} targetCanvas - canvas the difference map is drawn onto
 * @returns {HTMLCanvasElement} the same targetCanvas, now holding the difference map
 */
function generateDifferenceMap(originalCanvas, encodedCanvas, targetCanvas) {
  const originalCtx = originalCanvas.getContext('2d');
  const encodedCtx = encodedCanvas.getContext('2d');

  const width = originalCanvas.width;
  const height = originalCanvas.height;

  if (encodedCanvas.width !== width || encodedCanvas.height !== height) {
    throw new Error('originalCanvas and encodedCanvas must be the same dimensions.');
  }

  const originalData = originalCtx.getImageData(0, 0, width, height).data;
  const encodedData = encodedCtx.getImageData(0, 0, width, height).data;

  targetCanvas.width = width;
  targetCanvas.height = height;
  const targetCtx = targetCanvas.getContext('2d');
  const mapImageData = targetCtx.createImageData(width, height);
  const mapData = mapImageData.data;

  // Walk every pixel; compare R, G, B (skip alpha — encoding never touches it).
  for (let i = 0; i < originalData.length; i += 4) {
    const changed =
      originalData[i]     !== encodedData[i]     || // R
      originalData[i + 1] !== encodedData[i + 1] || // G
      originalData[i + 2] !== encodedData[i + 2];   // B

    if (changed) {
      mapData[i]     = 0;   // R
      mapData[i + 1] = 255; // G — neon green marks a changed pixel
      mapData[i + 2] = 0;   // B
    } else {
      mapData[i]     = 0;   // R
      mapData[i + 1] = 0;   // G
      mapData[i + 2] = 0;   // B — unchanged pixel stays black
    }
    mapData[i + 3] = 255; // always fully opaque, so the map is easy to read
  }

  targetCtx.putImageData(mapImageData, 0, 0);
  return targetCanvas;
}

/* =========================================================
   Audio Vault — AES-256-GCM file encryption (Web Crypto API)
   ---------------------------------------------------------
   Loaded as a classic <script> in this project (not an ES
   module), so it targets the browser's native `crypto.subtle`
   directly — no Node fallback needed here. The standalone
   isomorphic version of this logic (audioCrypto.js) is also
   available if you need this to run in Node.js too.
   ========================================================= */

const AUDIO_SUBTLE = window.crypto.subtle;
const AUDIO_ENCODER = new TextEncoder();

const AUDIO_IV_LENGTH_BYTES = 12;     // NIST-recommended GCM IV length
const AUDIO_TAG_LENGTH_BYTES = 16;    // 128-bit GCM auth tag
const AUDIO_TAG_LENGTH_BITS = AUDIO_TAG_LENGTH_BYTES * 8;
const AUDIO_SALT_LENGTH_BYTES = 16;   // 128-bit salt
const AUDIO_PBKDF2_ITERATIONS = 210000;

const AUDIO_MAGIC = AUDIO_ENCODER.encode('AGCM'); // container format tag
const AUDIO_FORMAT_VERSION = 1;

/**
 * Derives a non-extractable AES-256-GCM key from a password + salt via
 * PBKDF2-HMAC-SHA256. Non-extractable means the raw key bytes can never
 * be read back out of the CryptoKey object, even by malicious JS on the page.
 */
async function deriveAudioKey(password, salt, iterations) {
  const passwordKeyMaterial = await AUDIO_SUBTLE.importKey(
    'raw',
    AUDIO_ENCODER.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return AUDIO_SUBTLE.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    passwordKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
