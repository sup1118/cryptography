/* =========================================================
   Cryptography & Data Hide Sandbox — UI layer
   Handles: file input, canvas rendering, button wiring, logging.
   Actual LSB steganography logic lives in crypto.js
   (encodeMessage(canvas, secretText) / decodeMessage(canvas)),
   loaded as a <script> before this file so it's available here
   as a global.
   ========================================================= */

(function () {
  'use strict';

  /* ---------- DOM references ---------- */
  const imageInput    = document.getElementById('imageLoader');
  const fileDropText  = document.getElementById('file-drop-text');
  const canvas        = document.getElementById('imageCanvas');
  const canvasEmpty   = document.getElementById('canvas-empty');
  const ctx           = canvas.getContext('2d');
  const dimsLabel     = document.getElementById('dims-label');

  const secretText    = document.getElementById('secretText');
  const charCounter   = document.getElementById('char-counter');

  const encodeBtn     = document.getElementById('encodeBtn');
  const decodeBtn     = document.getElementById('decodeBtn');
  const downloadBtn   = document.getElementById('download-btn');

  const outputSection = document.getElementById('output-section');
  const decodedOutput = document.getElementById('decoded-output');
  const diffSection   = document.getElementById('diff-section');

  const statusDot     = document.getElementById('status-dot');
  const statusText    = document.getElementById('status-text');
  const logList       = document.getElementById('log-list');

  /* Keeps track of whether an image is currently loaded on canvas */
  let currentImage = null;

  /* ---------- Logging helper ---------- */
  function log(message, type) {
    const entry = document.createElement('li');
    entry.className = 'notebook__entry' + (type ? ' notebook__entry--' + type : '');
    entry.textContent = message;
    logList.appendChild(entry);
    logList.scrollTop = logList.scrollHeight;
  }

  function setStatus(text, state) {
    statusText.textContent = text;
    statusDot.classList.remove('is-loaded', 'is-error');
    if (state === 'loaded') statusDot.classList.add('is-loaded');
    if (state === 'error') statusDot.classList.add('is-error');
  }

  /* ---------- Image loading & canvas rendering ---------- */
  function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setStatus('Invalid file type', 'error');
      log('Rejected "' + file.name + '" — please choose an image file.', 'error');
      return;
    }

    fileDropText.textContent = file.name;

    const reader = new FileReader();
    reader.onload = function (readerEvent) {
      const img = new Image();
      img.onload = function () {
        drawImageToCanvas(img);
      };
      img.onerror = function () {
        setStatus('Could not decode image', 'error');
        log('Browser failed to decode "' + file.name + '".', 'error');
      };
      img.src = readerEvent.target.result;
    };
    reader.onerror = function () {
      setStatus('File read error', 'error');
      log('Could not read "' + file.name + '" from disk.', 'error');
    };
    reader.readAsDataURL(file);
  }

  function drawImageToCanvas(img) {
    // Canvas dimensions must match the image exactly (1:1 pixel mapping)
    // so LSB encoding/decoding operates on the true pixel data, not a
    // resized/interpolated version.
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    currentImage = img;
    canvas.style.display = 'block';
    canvasEmpty.classList.add('hidden');
    dimsLabel.textContent = canvas.width + ' x ' + canvas.height + ' px';

    // Snapshot the untouched pixel data now, before any encoding happens,
    // so generateDifferenceMap() has an unmodified baseline to compare against.
    // getImageData() already returns a copy per spec, but we go one step
    // further and clone the underlying byte array explicitly — this
    // guarantees window.originalImageData can never end up aliased to a
    // buffer that some later canvas operation (encode, redraw, etc.) mutates.
    const rawSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    window.originalImageData = new ImageData(
      new Uint8ClampedArray(rawSnapshot.data), // deep-cloned byte array
      rawSnapshot.width,
      rawSnapshot.height
    );

    setStatus('Image ready', 'loaded');
    log('Loaded image (' + canvas.width + 'x' + canvas.height + ').');

    // Reset any previous decoded output / diff map when a new image comes in
    outputSection.classList.add('hidden');
    decodedOutput.textContent = '';
    diffSection.classList.add('hidden');

    updateButtonStates();
  }

  /* ---------- Message textarea ---------- */
  function handleMessageInput() {
    const len = secretText.value.length;
    charCounter.textContent = len + (len === 1 ? ' character' : ' characters');
    updateButtonStates();
  }

  /* ---------- Button state management ---------- */
  function updateButtonStates() {
    const hasImage = !!currentImage;
    const hasMessage = secretText.value.trim().length > 0;

    encodeBtn.disabled = !(hasImage && hasMessage);
    decodeBtn.disabled = !hasImage;
    downloadBtn.disabled = true; // re-enabled only after a successful encode
  }

  /* ---------- Button handlers ---------- */
  function handleEncodeClick() {
    // Guard: make sure an image has actually been uploaded onto the canvas
    if (!currentImage) {
      setStatus('No image loaded', 'error');
      log('Cannot encode — upload a PNG onto the canvas first.', 'error');
      return;
    }

    const message = secretText.value;
    if (!message.trim()) {
      log('Cannot encode — the message field is empty.', 'error');
      return;
    }

    log('Encoding message into image...');

    try {
      encodeMessage(canvas, message); // from crypto.js — mutates canvas in place
      downloadBtn.disabled = false;
      log('Message encoded successfully.');

      generateDifferenceMap();
      diffSection.classList.remove('hidden');
      log('Difference map generated.');
    } catch (err) {
      log('Encoding failed: ' + err.message, 'error');
    }
  }

  function handleDecodeClick() {
    // Guard: make sure an image has actually been uploaded onto the canvas
    if (!currentImage) {
      setStatus('No image loaded', 'error');
      log('Cannot decode — upload a PNG onto the canvas first.', 'error');
      return;
    }

    log('Decoding message from image...');

    try {
      const message = decodeMessage(canvas); // from crypto.js

      if (message !== null && message !== undefined) {
        decodedOutput.textContent = message;
        outputSection.classList.remove('hidden');
        log('Message decoded successfully.');
      } else {
        log('No hidden message found in this image.', 'error');
      }
    } catch (err) {
      log('Decoding failed: ' + err.message, 'error');
    }
  }

  function handleDownloadClick() {
    const link = document.createElement('a');
    link.download = 'encoded-image.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  /* ---------- Difference map ---------- */
  function generateDifferenceMap() {
    const mainCanvas = document.getElementById('imageCanvas');
    const diffCanvas = document.getElementById('diffCanvas');

    if (!mainCanvas || !diffCanvas) {
      log('Difference map skipped — canvas elements not found.', 'error');
      return;
    }
    if (!window.originalImageData) {
      log('Difference map skipped — no original snapshot saved yet.', 'error');
      return;
    }

    const ctx = mainCanvas.getContext('2d');
    const diffCtx = diffCanvas.getContext('2d');

    // Match dimensions
    diffCanvas.width = mainCanvas.width;
    diffCanvas.height = mainCanvas.height;

    const currentImgData = ctx.getImageData(0, 0, mainCanvas.width, mainCanvas.height);
    const origData = window.originalImageData.data;
    const currData = currentImgData.data;

    // Create blank image data for the difference map
    const diffImgData = diffCtx.createImageData(mainCanvas.width, mainCanvas.height);
    const dData = diffImgData.data;

    let changedPixelCount = 0;

    for (let i = 0; i < origData.length; i += 4) {
      // Compare R, G, B channels
      const rDiff = Math.abs(origData[i] - currData[i]);
      const gDiff = Math.abs(origData[i + 1] - currData[i + 1]);
      const bDiff = Math.abs(origData[i + 2] - currData[i + 2]);

      if (rDiff > 0 || gDiff > 0 || bDiff > 0) {
        // Changed pixel — vivid gold, matching the sandbox's accent color
        dData[i] = 234;     // R
        dData[i + 1] = 182; // G
        dData[i + 2] = 55;  // B
        dData[i + 3] = 255; // Alpha (fully visible)
        changedPixelCount++;
      } else {
        // Unchanged pixel — dark charcoal
        dData[i] = 26;
        dData[i + 1] = 26;
        dData[i + 2] = 26;
        dData[i + 3] = 255;
      }
    }

    diffCtx.putImageData(diffImgData, 0, 0);

    // This number is the real diagnostic: LSB steganography only ever touches
    // the pixels needed to store the message, so on a large image with a short
    // message, expect a small cluster in the top-left corner — not full-canvas
    // noise. That's correct behavior, not a bug.
    log(changedPixelCount + ' pixel(s) altered out of ' + (origData.length / 4) + '.');
  }

  /* ---------- Event wiring ---------- */
  imageInput.addEventListener('change', handleFileChange);
  secretText.addEventListener('input', handleMessageInput);
  encodeBtn.addEventListener('click', handleEncodeClick);
  decodeBtn.addEventListener('click', handleDecodeClick);
  downloadBtn.addEventListener('click', handleDownloadClick);

  /* Initial UI state */
  updateButtonStates();
})();
