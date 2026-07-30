/* =========================================================
   Cryptography & Data Hide Sandbox — LSB Steganography Core
   Pure, UI-agnostic functions. No DOM lookups beyond the
   canvas element passed in as an argument.
   ========================================================= */

const END_DELIMITER = '##END##';

/* ---------- Binary <-> text helpers ---------- */

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

/**
 * Hides `secretText` inside the pixel data of `canvas` using LSB
 * substitution on the R, G, and B channels (alpha is left untouched
 * so transparency is never altered).
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
 * Visualizes exactly which pixel channels differ between the original
 * and encoded canvases — pure black where a channel is unchanged, bright
 * neon green where LSB encoding altered a channel. Painted onto
 * `targetCanvas`, which is resized to match the source dimensions.
 *
 * Pure with respect to its inputs: reads pixel data from the two source
 * canvases and only ever writes to targetCanvas, never mutating the
 * original or encoded canvases.
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

/**
 * Binary container layout:
 *   [ MAGIC 4B ] [ VERSION 1B ] [ ITERATIONS 4B ] [ SALT_LEN 1B ] [ IV_LEN 1B ]
 *   [ SALT ] [ IV ] [ TAG 16B ] [ CIPHERTEXT ...]
 * Storing iteration count / lengths inline keeps old files decryptable
 * even if these constants change in a future version.
 */
function packAudioContainer({ salt, iv, iterations, tag, ciphertext }) {
  const headerLength = AUDIO_MAGIC.length + 1 + 4 + 1 + 1;
  const totalLength = headerLength + salt.length + iv.length + tag.length + ciphertext.length;

  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);
  let offset = 0;

  out.set(AUDIO_MAGIC, offset); offset += AUDIO_MAGIC.length;
  view.setUint8(offset, AUDIO_FORMAT_VERSION); offset += 1;
  view.setUint32(offset, iterations, false); offset += 4;
  view.setUint8(offset, salt.length); offset += 1;
  view.setUint8(offset, iv.length); offset += 1;
  out.set(salt, offset); offset += salt.length;
  out.set(iv, offset); offset += iv.length;
  out.set(tag, offset); offset += tag.length;
  out.set(ciphertext, offset);

  return out;
}

function unpackAudioContainer(containerBuffer) {
  const bytes = new Uint8Array(containerBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const magic = bytes.slice(offset, offset + AUDIO_MAGIC.length);
  offset += AUDIO_MAGIC.length;
  if (!magic.every((b, i) => b === AUDIO_MAGIC[i])) {
    throw new Error('Not a recognized .agcm file (bad header) — wrong file, or file is corrupted.');
  }

  const version = view.getUint8(offset); offset += 1;
  if (version !== AUDIO_FORMAT_VERSION) {
    throw new Error(`Unsupported .agcm version: ${version}`);
  }

  const iterations = view.getUint32(offset, false); offset += 4;
  const saltLength = view.getUint8(offset); offset += 1;
  const ivLength = view.getUint8(offset); offset += 1;

  const salt = bytes.slice(offset, offset + saltLength); offset += saltLength;
  const iv = bytes.slice(offset, offset + ivLength); offset += ivLength;
  const tag = bytes.slice(offset, offset + AUDIO_TAG_LENGTH_BYTES); offset += AUDIO_TAG_LENGTH_BYTES;
  const ciphertext = bytes.slice(offset);

  return { iterations, salt, iv, tag, ciphertext };
}

/**
 * Encrypts a raw audio ArrayBuffer under a password. Returns a Uint8Array
 * container ready to save/download.
 */
async function encryptAudioFile(password, audioArrayBuffer, iterations = AUDIO_PBKDF2_ITERATIONS) {
  if (!password) throw new Error('A password is required to encrypt.');

  // Fresh random salt + IV every single time — never reused across files,
  // even for the same password. This is what makes identical passwords
  // still produce unrelated keys, and keeps GCM's security guarantees intact.
  const salt = window.crypto.getRandomValues(new Uint8Array(AUDIO_SALT_LENGTH_BYTES));
  const iv = window.crypto.getRandomValues(new Uint8Array(AUDIO_IV_LENGTH_BYTES));

  const key = await deriveAudioKey(password, salt, iterations);
  const plaintext = new Uint8Array(audioArrayBuffer);

  // AES-GCM returns ciphertext with the 16-byte auth tag appended; we slice
  // it back off so the container stores it as an explicit, labeled field.
  const encryptedBuffer = await AUDIO_SUBTLE.encrypt(
    { name: 'AES-GCM', iv, tagLength: AUDIO_TAG_LENGTH_BITS },
    key,
    plaintext
  );
  const encryptedBytes = new Uint8Array(encryptedBuffer);
  const tag = encryptedBytes.slice(encryptedBytes.length - AUDIO_TAG_LENGTH_BYTES);
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - AUDIO_TAG_LENGTH_BYTES);

  return packAudioContainer({ salt, iv, iterations, tag, ciphertext });
}

/**
 * Decrypts a container produced by encryptAudioFile(). Throws (with a
 * deliberately generic message) if the password is wrong OR the file has
 * been tampered with — GCM's tag check makes those two cases indistinguishable
 * by design, which is the correct, safe behavior.
 */
async function decryptAudioFile(password, containerArrayBuffer) {
  if (!password) throw new Error('A password is required to decrypt.');

  const { iterations, salt, iv, tag, ciphertext } = unpackAudioContainer(containerArrayBuffer);
  const key = await deriveAudioKey(password, salt, iterations);

  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);

  try {
    return await AUDIO_SUBTLE.decrypt(
      { name: 'AES-GCM', iv, tagLength: AUDIO_TAG_LENGTH_BITS },
      key,
      combined
    );
  } catch (err) {
    throw new Error('Decryption failed: incorrect password, or the file is corrupted/tampered with.');
  }
}
