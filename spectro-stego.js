/* =========================================================
   Text-to-Spectrogram Audio Steganography
   ---------------------------------------------------------
   Pure vanilla JS, zero dependencies. Self-contained IIFE so
   dropping this into a larger sandbox codebase can't leak
   globals or collide with other scripts on the page.

   Pipeline:
     1. Render secret text as white-on-black pixels on an
        offscreen canvas (the "bitmap matrix").
     2. Read each column (time slice) top-to-bottom (pitch),
        turning lit pixels into target frequencies.
     3. Additively synthesize sine waves per time slice,
        concatenate into one PCM buffer, normalize.
     4. Play it back through Web Audio, routed through an
        AnalyserNode that drives a live waterfall spectrogram.
     5. Optionally export the same PCM buffer as a 16-bit WAV.
     6. Decode: analyze an uploaded .wav with the Goertzel
        algorithm at the same target frequencies used to encode,
        and reconstruct the bitmap so the message can be read
        visually — there's no bit-exact text recovery, since the
        message was never encoded as bits, only as a picture.
   ========================================================= */

(function () {
  'use strict';

  /* ---------- DOM references ---------- */
  const secretTextInput   = document.getElementById('spectroSecretText');
  const durationSlider    = document.getElementById('spectroDurationSlider');
  const durationValueEl   = document.getElementById('spectroDurationValue');
  const minFreqSlider     = document.getElementById('spectroMinFreqSlider');
  const minFreqValueEl    = document.getElementById('spectroMinFreqValue');
  const maxFreqSlider     = document.getElementById('spectroMaxFreqSlider');
  const maxFreqValueEl    = document.getElementById('spectroMaxFreqValue');

  const synthesizeBtn     = document.getElementById('spectroSynthesizeBtn');
  const stopBtn           = document.getElementById('spectroStopBtn');
  const exportBtn         = document.getElementById('spectroExportBtn');

  const bitmapCanvas      = document.getElementById('spectroBitmapCanvas');
  const analyzerCanvas    = document.getElementById('spectroAnalyzerCanvas');
  const decodedCanvas     = document.getElementById('spectroDecodedCanvas');
  const playbackHintEl    = document.getElementById('spectroPlaybackHint');
  const logList           = document.getElementById('spectroLog');

  const decodeInput       = document.getElementById('spectroDecodeInput');
  const decodeFileNameEl  = document.getElementById('spectroDecodeFileName');
  const decodeBtn         = document.getElementById('spectroDecodeBtn');

  // Guard: if this script is loaded on a page that hasn't included the
  // matching HTML card, bail out quietly instead of throwing on null refs.
  if (!secretTextInput || !bitmapCanvas || !analyzerCanvas || !decodedCanvas) return;

  const bitmapCtx   = bitmapCanvas.getContext('2d');
  const analyzerCtx = analyzerCanvas.getContext('2d');
  const decodedCtx  = decodedCanvas.getContext('2d');

  /* ---------- Synthesis constants ---------- */
  const FREQ_BINS = 128;              // rows in the bitmap grid (Y axis / pitch)
  const COLUMNS_PER_SECOND = 40;      // time resolution (X axis)
  const MIN_COLUMNS = 60;
  const MAX_COLUMNS = 320;
  const SAMPLE_RATE = 44100;
  const CLIP_HEADROOM = 0.98;         // normalize target, leaves a little headroom

  /* ---------- Mutable playback state ---------- */
  let audioCtx = null;
  let sourceNode = null;
  let analyserNode = null;
  let freqDataArray = null;
  let animationFrameId = null;
  let isPlaying = false;
  let lastNormalizedBuffer = null;   // Float32Array, kept around for WAV export
  let lastMinFreq = 500;
  let lastMaxFreq = 8000;

  /* ---------- Logging ---------- */
  function log(text, variant) {
    const entry = document.createElement('li');
    entry.className = 'spectro-log__entry' + (variant ? ' spectro-log__entry--' + variant : '');
    entry.textContent = text;
    logList.appendChild(entry);
    logList.scrollTop = logList.scrollHeight;
  }

  /* ---------- Slider label wiring ---------- */
  function refreshSliderLabels() {
    durationValueEl.textContent = parseFloat(durationSlider.value).toFixed(1) + 's';
    minFreqValueEl.textContent = minFreqSlider.value + ' Hz';
    maxFreqValueEl.textContent = maxFreqSlider.value + ' Hz';
  }
  durationSlider.addEventListener('input', refreshSliderLabels);
  minFreqSlider.addEventListener('input', refreshSliderLabels);
  maxFreqSlider.addEventListener('input', refreshSliderLabels);
  refreshSliderLabels();

  /* =========================================================
     STEP 1 — Render secret text as a black/white pixel grid
     ========================================================= */

  /**
   * Draws `text` centered on an offscreen columns x rows canvas, high-
   * contrast white on pure black, and returns its ImageData.
   */
  function renderTextBitmap(text, columns, rows) {
    const off = document.createElement('canvas');
    off.width = columns;
    off.height = rows;
    const offCtx = off.getContext('2d');

    offCtx.fillStyle = '#000000';
    offCtx.fillRect(0, 0, columns, rows);

    const label = (text || 'SECRET').toUpperCase();

    offCtx.fillStyle = '#ffffff';
    offCtx.textAlign = 'center';
    offCtx.textBaseline = 'middle';

    // Start with a font sized to roughly fill the grid's height, then shrink
    // it down if the text is too wide to fit — keeps short and long messages
    // both legible instead of clipping off the edges.
    let fontSize = Math.floor(rows * 0.8);
    offCtx.font = 'bold ' + fontSize + 'px monospace';
    let textWidth = offCtx.measureText(label).width;
    const maxWidth = columns * 0.94;

    if (textWidth > maxWidth) {
      fontSize = Math.max(6, Math.floor(fontSize * (maxWidth / textWidth)));
      offCtx.font = 'bold ' + fontSize + 'px monospace';
    }

    offCtx.fillText(label, columns / 2, rows / 2 + 1);

    return offCtx.getImageData(0, 0, columns, rows);
  }

  /**
   * Converts bitmap ImageData into a per-column list of target frequencies.
   * Row 0 (top) maps to maxFreq, the bottom row maps to minFreq — matching
   * conventional spectrogram orientation (pitch rises upward).
   *
   *   F(Y) = minFreq + (maxFreq - minFreq) * (1 - Y / height)
   */
  function bitmapToColumnFrequencies(imageData, minFreq, maxFreq) {
    const { data, width, height } = imageData;
    const columns = [];

    for (let x = 0; x < width; x++) {
      const freqsForColumn = [];
      for (let y = 0; y < height; y++) {
        const pixelIndex = (y * width + x) * 4;
        const brightness = data[pixelIndex]; // R channel; image is grayscale so R=G=B
        if (brightness > 127) {
          const freq = minFreq + (maxFreq - minFreq) * (1 - y / height);
          freqsForColumn.push(freq);
        }
      }
      columns.push(freqsForColumn);
    }

    return columns;
  }

  /* =========================================================
     STEP 2 — Additive sine synthesis
     ========================================================= */

  /**
   * Generates a Float32Array PCM buffer by summing sine waves for every
   * active frequency in each time-slice (column), then normalizes the
   * whole buffer to prevent clipping.
   */
  function synthesizePCM(columnFrequencies, durationSeconds, sampleRate) {
    const totalSamples = Math.round(durationSeconds * sampleRate);
    const buffer = new Float32Array(totalSamples);
    const columnCount = columnFrequencies.length;

    for (let x = 0; x < columnCount; x++) {
      const freqs = columnFrequencies[x];
      if (freqs.length === 0) continue; // silent slice — leave zeros

      // Column-level normalization: divide by how many frequencies are
      // stacked in this slice, so a column with 10 active pixels isn't
      // 10x louder than a column with 1. The final pass below still
      // re-normalizes the whole buffer as a safety net.
      const amplitude = 1 / freqs.length;

      const startSample = Math.floor((x / columnCount) * totalSamples);
      const endSample = Math.floor(((x + 1) / columnCount) * totalSamples);

      for (let s = startSample; s < endSample; s++) {
        const t = s / sampleRate;
        let sampleValue = 0;
        for (let f = 0; f < freqs.length; f++) {
          sampleValue += Math.sin(2 * Math.PI * freqs[f] * t);
        }
        buffer[s] += sampleValue * amplitude;
      }
    }

    // Short linear fade-in/fade-out (5ms) on the whole buffer to avoid an
    // audible "click" at the very start/end of playback.
    const fadeSamples = Math.min(Math.floor(sampleRate * 0.005), Math.floor(totalSamples / 2));
    for (let i = 0; i < fadeSamples; i++) {
      const fade = i / fadeSamples;
      buffer[i] *= fade;
      buffer[totalSamples - 1 - i] *= fade;
    }

    // Global normalization — find the loudest sample in the whole buffer
    // and scale everything down so the peak sits at CLIP_HEADROOM instead
    // of exceeding +/-1.0, which would otherwise clip/distort on playback
    // and produce an invalid WAV file.
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      const abs = Math.abs(buffer[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 0) {
      const scale = CLIP_HEADROOM / peak;
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] *= scale;
      }
    }

    return buffer;
  }

  /* =========================================================
     STEP 3 — Draw the static bitmap matrix (Canvas A)
     ========================================================= */

  function drawBitmapCanvas(imageData) {
    const { width, height } = imageData;

    // Render the small offscreen grid onto the larger visible canvas,
    // recoloring black->near-black and white->neon mint so it matches the
    // security-tool aesthetic instead of literal black-and-white text.
    const temp = document.createElement('canvas');
    temp.width = width;
    temp.height = height;
    const tempCtx = temp.getContext('2d');
    const recolored = tempCtx.createImageData(width, height);

    for (let i = 0; i < imageData.data.length; i += 4) {
      const on = imageData.data[i] > 127;
      recolored.data[i]     = on ? 182 : 6;   // R
      recolored.data[i + 1] = on ? 255 : 9;   // G
      recolored.data[i + 2] = on ? 232 : 10;  // B
      recolored.data[i + 3] = 255;            // A
    }
    tempCtx.putImageData(recolored, 0, 0);

    bitmapCanvas.width = width;
    bitmapCanvas.height = height;
    bitmapCtx.imageSmoothingEnabled = false;
    bitmapCtx.clearRect(0, 0, bitmapCanvas.width, bitmapCanvas.height);
    bitmapCtx.drawImage(temp, 0, 0);
  }

  /* =========================================================
     STEP 4 — Playback + live spectrogram (Canvas B)
     ========================================================= */

  function intensityToRGB(value /* 0-255 */) {
    // Three-stop gradient: dark teal -> cyan-green -> near-white mint,
    // matching the neon-on-dark aesthetic used across the sandbox's
    // canvas panels. Returns a plain [r,g,b] array so it can be used both
    // for canvas fillStyle strings and for writing raw ImageData bytes.
    const t = value / 255;
    if (t < 0.5) {
      return lerpColor([10, 22, 24], [23, 198, 163], t / 0.5);
    }
    return lerpColor([23, 198, 163], [182, 255, 232], (t - 0.5) / 0.5);
  }

  function intensityToColor(value /* 0-255 */) {
    const [r, g, b] = intensityToRGB(value);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function lerpColor(a, b, t) {
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return [r, g, bl];
  }

  function drawSpectrogramFrame() {
    if (!isPlaying || !analyserNode) return;
    animationFrameId = requestAnimationFrame(drawSpectrogramFrame);

    analyserNode.getByteFrequencyData(freqDataArray);

    const w = analyzerCanvas.width;
    const h = analyzerCanvas.height;

    // Scroll the existing waterfall one pixel to the left...
    const existing = analyzerCtx.getImageData(1, 0, w - 1, h);
    analyzerCtx.putImageData(existing, 0, 0);

    // ...then draw one fresh column of frequency intensities at the
    // right edge. Row-to-frequency mapping mirrors the same formula used
    // to encode the message, so the live spectrogram lines up visually
    // with Canvas A's static bitmap.
    const nyquist = audioCtx.sampleRate / 2;
    for (let y = 0; y < h; y++) {
      const freqForRow = lastMinFreq + (lastMaxFreq - lastMinFreq) * (1 - y / h);
      const binIndex = Math.min(
        freqDataArray.length - 1,
        Math.max(0, Math.round((freqForRow / nyquist) * freqDataArray.length))
      );
      const value = freqDataArray[binIndex];
      analyzerCtx.fillStyle = intensityToColor(value);
      analyzerCtx.fillRect(w - 1, y, 1, 1);
    }
  }

  function clearSpectrogramCanvas() {
    analyzerCtx.fillStyle = '#06090a';
    analyzerCtx.fillRect(0, 0, analyzerCanvas.width, analyzerCanvas.height);
  }

  function stopPlayback(reason) {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) { /* already stopped — ignore */ }
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    isPlaying = false;
    stopBtn.disabled = true;
    playbackHintEl.textContent = 'idle';
    if (reason) log(reason);
  }

  function playPCMBuffer(pcmFloat32, sampleRate) {
    stopPlayback();

    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

    const buffer = audioCtx.createBuffer(1, pcmFloat32.length, sampleRate);
    if (buffer.copyToChannel) {
      buffer.copyToChannel(pcmFloat32, 0);
    } else {
      buffer.getChannelData(0).set(pcmFloat32);
    }

    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = buffer;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.35;
    freqDataArray = new Uint8Array(analyserNode.frequencyBinCount);

    sourceNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    sourceNode.onended = () => {
      if (isPlaying) stopPlayback('Playback finished.');
    };

    sourceNode.start();
    isPlaying = true;
    stopBtn.disabled = false;
    playbackHintEl.textContent = 'playing…';
    clearSpectrogramCanvas();
    drawSpectrogramFrame();
  }

  /* =========================================================
     STEP 5 — WAV export
     ========================================================= */

  /**
   * Encodes a Float32Array of samples in range [-1, 1] as a standard
   * 16-bit PCM mono WAV file, returned as a Blob.
   */
  function encodeWAV(samples, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * 2; // 2 bytes per 16-bit sample

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    // --- RIFF header ---
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);  // file length minus first 8 bytes
    writeString(8, 'WAVE');

    // --- fmt sub-chunk ---
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);            // sub-chunk size (16 for PCM)
    view.setUint16(20, 1, true);             // audio format: 1 = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // --- data sub-chunk ---
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      // Clamp defensively even though synthesizePCM() already normalized —
      // guards against a caller passing in an un-normalized buffer directly.
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, intSample, true);
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  /* =========================================================
     STEP 6 — Decoding: reconstruct the bitmap from an audio file
     ---------------------------------------------------------
     There's no bit-level text encoding here to invert — the message
     was hidden as a *visual* pattern in frequency-vs-time space, the
     same way the classic technique works (e.g. Aphex Twin's
     spectrogram easter eggs). So "decoding" means reconstructing that
     pattern well enough for a human to read it, not recovering an
     exact string programmatically.

     For each time-slice (column), we don't run a generic FFT — we
     already know exactly which FREQ_BINS target frequencies matter
     (the same linear mapping used to encode), so we use the Goertzel
     algorithm to measure the energy at each of those specific
     frequencies directly. This is cheaper than a full FFT and needs
     zero external libraries.
     ========================================================= */

  /**
   * Measures the energy of `samples[startIndex..endIndex)` at exactly
   * `targetFreq`, using the Goertzel algorithm — effectively a single-bin
   * DFT, far cheaper than computing (and discarding) a full spectrum when
   * we only care about a handful of known frequencies.
   */
  function goertzelMagnitude(samples, startIndex, endIndex, targetFreq, sampleRate) {
    const n = endIndex - startIndex;
    if (n <= 0) return 0;

    const k = Math.round((n * targetFreq) / sampleRate);
    const omega = (2 * Math.PI * k) / n;
    const cosine = Math.cos(omega);
    const coeff = 2 * cosine;

    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = startIndex; i < endIndex; i++) {
      q0 = coeff * q1 - q2 + samples[i];
      q2 = q1;
      q1 = q0;
    }

    const real = q1 - q2 * cosine;
    const imag = q2 * Math.sin(omega);
    return Math.sqrt(real * real + imag * imag) / n;
  }

  /**
   * Analyzes a decoded AudioBuffer and reconstructs a columns x rows grid
   * of normalized (0-1) intensities — one Goertzel measurement per pixel
   * of the original encoding grid. Uses the SAME column count formula and
   * the SAME row-to-frequency mapping as the encoder, so the picture
   * lines up correctly only if minFreq/maxFreq match what was used to
   * encode (which is why decode reuses the current slider values rather
   * than guessing).
   */
  function analyzeAudioBuffer(audioBuffer, minFreq, maxFreq) {
    const samples = audioBuffer.getChannelData(0); // mono; ignores extra channels
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = samples.length;

    const columns = Math.min(
      MAX_COLUMNS,
      Math.max(MIN_COLUMNS, Math.round(audioBuffer.duration * COLUMNS_PER_SECOND))
    );
    const rows = FREQ_BINS;
    const grid = [];

    for (let x = 0; x < columns; x++) {
      const startSample = Math.floor((x / columns) * totalSamples);
      const endSample = Math.floor(((x + 1) / columns) * totalSamples);

      const rawMagnitudes = new Float32Array(rows);
      let columnMax = 0;

      for (let y = 0; y < rows; y++) {
        const freq = minFreq + (maxFreq - minFreq) * (1 - y / rows);
        const magnitude = goertzelMagnitude(samples, startSample, endSample, freq, sampleRate);
        rawMagnitudes[y] = magnitude;
        if (magnitude > columnMax) columnMax = magnitude;
      }

      // Normalize each column to its OWN loudest bin, mirroring the
      // encoder's per-column amplitude normalization. This means
      // brightness reflects which pitch dominates within that instant,
      // not absolute loudness — which varies a lot between a column
      // with many active pixels and one with just a couple.
      const normalized = new Float32Array(rows);
      if (columnMax > 0) {
        for (let y = 0; y < rows; y++) {
          normalized[y] = rawMagnitudes[y] / columnMax;
        }
      }
      grid.push(normalized);
    }

    return { grid, columns, rows };
  }

  /**
   * Paints the reconstructed grid onto Canvas C using the same neon
   * gradient as the live spectrogram, so the visual language is
   * consistent between "watching it play" and "reading a file back."
   */
  function drawDecodedCanvas(analysis) {
    const { grid, columns, rows } = analysis;

    decodedCanvas.width = columns;
    decodedCanvas.height = rows;
    const imageData = decodedCtx.createImageData(columns, rows);

    for (let x = 0; x < columns; x++) {
      const columnData = grid[x];
      for (let y = 0; y < rows; y++) {
        const [r, g, b] = intensityToRGB(columnData[y] * 255);
        const idx = (y * columns + x) * 4;
        imageData.data[idx] = r;
        imageData.data[idx + 1] = g;
        imageData.data[idx + 2] = b;
        imageData.data[idx + 3] = 255;
      }
    }

    decodedCtx.putImageData(imageData, 0, 0);
  }

  /* =========================================================
     Button handlers
     ========================================================= */

  function handleSynthesizeClick() {
    const text = secretTextInput.value.trim() || 'SECRET';
    const duration = parseFloat(durationSlider.value);
    const minFreq = parseInt(minFreqSlider.value, 10);
    const maxFreq = parseInt(maxFreqSlider.value, 10);

    if (minFreq >= maxFreq) {
      log('Min frequency must be lower than max frequency.', 'error');
      return;
    }

    lastMinFreq = minFreq;
    lastMaxFreq = maxFreq;

    log('Rendering "' + text + '" as a ' + duration.toFixed(1) + 's tone grid...');

    const columns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(duration * COLUMNS_PER_SECOND)));
    const imageData = renderTextBitmap(text, columns, FREQ_BINS);
    drawBitmapCanvas(imageData);

    const columnFrequencies = bitmapToColumnFrequencies(imageData, minFreq, maxFreq);
    const activePixelCount = columnFrequencies.reduce((sum, col) => sum + col.length, 0);

    if (activePixelCount === 0) {
      log('No lit pixels rendered — try shorter text or a longer duration.', 'error');
      return;
    }

    log('Synthesizing ' + activePixelCount + ' active pixels into audio...');

    const pcm = synthesizePCM(columnFrequencies, duration, SAMPLE_RATE);
    lastNormalizedBuffer = pcm;
    exportBtn.disabled = false;

    playPCMBuffer(pcm, SAMPLE_RATE);
    log('Playing synthesized audio.');
  }

  function handleStopClick() {
    stopPlayback('Playback stopped.');
  }

  function handleExportClick() {
    if (!lastNormalizedBuffer) {
      log('Nothing to export yet — synthesize a message first.', 'error');
      return;
    }
    const blob = encodeWAV(lastNormalizedBuffer, SAMPLE_RATE);
    downloadBlob(blob, 'spectrogram_secret.wav');
    log('Exported spectrogram_secret.wav.');
  }

  let selectedDecodeFile = null;

  function handleDecodeFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    selectedDecodeFile = file;
    decodeFileNameEl.textContent = file.name;
    decodeBtn.disabled = false;
  }

  async function handleDecodeClick() {
    if (!selectedDecodeFile) return;

    const minFreq = parseInt(minFreqSlider.value, 10);
    const maxFreq = parseInt(maxFreqSlider.value, 10);
    if (minFreq >= maxFreq) {
      log('Min frequency must be lower than max frequency.', 'error');
      return;
    }

    log('Decoding "' + selectedDecodeFile.name + '" — reconstructing bitmap...');

    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      // decodeAudioData is called from a click handler, so this satisfies
      // browser autoplay-gesture requirements if the context needs resuming.
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const arrayBuffer = await selectedDecodeFile.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const analysis = analyzeAudioBuffer(audioBuffer, minFreq, maxFreq);
      drawDecodedCanvas(analysis);

      log('Reconstructed a ' + analysis.columns + 'x' + analysis.rows + ' bitmap — read the letters in FIG. C.');
    } catch (err) {
      log('Decode failed: ' + err.message, 'error');
    }
  }

  /* ---------- Event wiring ---------- */
  synthesizeBtn.addEventListener('click', handleSynthesizeClick);
  stopBtn.addEventListener('click', handleStopClick);
  exportBtn.addEventListener('click', handleExportClick);
  decodeInput.addEventListener('change', handleDecodeFileChange);
  decodeBtn.addEventListener('click', handleDecodeClick);

  /* Initial state: paint an empty dark canvas so it doesn't look broken
     before the first synthesis run. */
  clearSpectrogramCanvas();
})();
