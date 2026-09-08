import init, { LeniaApp } from './pkg/lenia_rs.js';
import { RollingAverage } from './ring-buffer.mjs';
import { renderCable, ensureCableFilter, resetCableColorCycle } from './ui-render-helpers.js';

// Target simulation cell size in device pixels. Grid resolution is derived
// from the canvas's pixel dimensions divided by this, so cells stay square
// regardless of window aspect ratio. Smaller = more detail but a bigger FFT
// (slower); this value balances visual detail against 60fps at ~1920x1080.
const CELL_PX = 4;

// Grid dimensions scale with canvas physical pixels (CSS size *
// devicePixelRatio), uncapped by CELL_PX alone — a 4K display at DPR 2 can
// produce a ~960x540 grid, measured at ~17ms for step() alone (already over
// the entire 60fps frame budget, before render/upload). MAX_GRID_DIM caps
// each dimension at a size actually benchmarked to stay well within budget
// (512x512 costs ~4.1ms; see docs/perf/). The canvas itself still renders
// at full physical resolution — only the simulation grid feeding it is
// capped, so a display over the cap gets a coarser (blockier) simulation
// rather than a slideshow.
const MAX_GRID_DIM = 512;

// Candidate threshold for tier 3 item 1's active-region tracking
// (docs/perf/tier3-spec.md section 2b) — NOT validated yet, and NOT used
// to change simulation/render behavior anywhere. This only feeds the HUD
// bbox readout and capture payload below, so real sessions can be
// captured and the actual bbox-vs-eps tradeoff evaluated before this
// number (or the windowed step it would gate) is committed to.
const ACTIVE_REGION_EPS_CANDIDATE = 1e-4;

// Grid dimensions feed a 2D real FFT (rustfft/realfft) whose per-axis cost
// depends heavily on how the length factors: even 5-smooth lengths
// (2^a * 3^b * 5^c) get fast mixed-radix paths, while odd or prime-ish
// lengths get routed to the ~2x-cost odd-length path and, for large prime
// factors, Bluestein/Rader's (several times worse still). Arbitrary
// devicePixelRatio/window-size combinations regularly land on these
// landmines (e.g. DPR 1.25 on a 1920x1080 display produces a grid height of
// 337, which is prime) — see docs/perf/audit-2026-08-28.md item 2. Snapping
// each axis down to the nearest even 5-smooth value avoids this and is
// never worse than the unsnapped size (fewer or equal cells, same or better
// factorization).
function isFiveSmooth(n) {
  for (const p of [2, 3, 5]) {
    while (n % p === 0) n /= p;
  }
  return n === 1;
}

function snapDownToFftFriendlySize(n) {
  let candidate = Math.floor(n);
  if (candidate < 2) return Math.max(1, candidate);
  if (candidate % 2 !== 0) candidate -= 1;
  while (candidate >= 2 && !isFiveSmooth(candidate)) {
    candidate -= 2;
  }
  return Math.max(2, candidate);
}

async function main() {
  await init();

  const canvas = document.getElementById('lenia-canvas');
  let currentPatternPath = 'patterns/orbium.json';
  let resizeDebounceHandle = null;

  const HUD_WINDOW = 60; // ~1s of frames at 60fps
  const stepAvg = new RollingAverage(HUD_WINDOW);
  const renderAvg = new RollingAverage(HUD_WINDOW);
  const gpuAvg = new RollingAverage(HUD_WINDOW);
  const frameAvg = new RollingAverage(HUD_WINDOW);
  // Per-stage step() breakdown — only populated while the HUD is open or a
  // capture is running (see frame()'s isProfiling branch below), so the
  // default path never pays for the extra wasm-boundary crossings these
  // require (docs/perf/audit-2026-08-28.md item 11 / tier2-spec.md item 11).
  const fftFwdAvg = new RollingAverage(HUD_WINDOW);
  const multiplyAvg = new RollingAverage(HUD_WINDOW);
  const fftInvAvg = new RollingAverage(HUD_WINDOW);
  const growthAvg = new RollingAverage(HUD_WINDOW);
  // Active-region bbox stats (tier 3 item 1 eps-tuning data gathering) —
  // a snapshot, not averaged, since bbox size is a state property to
  // observe over time rather than a per-frame timing to smooth. Also only
  // populated under isProfiling, same as the stage-timing averages above.
  let lastActiveBbox = null; // { w, h, fraction } or null (empty grid)
  let lastVacuumGrows = false;
  // What step() actually did this frame (see sim::StepMode in Rust):
  // 0 = full-grid, scan ran and found nothing; 1 = full-grid, negative
  // cache skipped the scan; 2 = windowed. Distinct from lastActiveBbox
  // above — that's a fresh unconditional scan for eps-tuning purposes,
  // this is the real hysteresis/negative-cache-aware decision step()
  // used, which can differ (e.g. a larger hysteresis-retained window, or
  // no scan at all this frame).
  let lastStepMode = null;
  let lastCurrentWindow = null; // { x0, y0, w, h } or null (full-grid this frame)
  let lastFrameStart = performance.now();
  let capturing = false;
  let captureFrames = [];
  let captureUntil = 0;

  let lastHudUpdate = 0;
  const HUD_UPDATE_INTERVAL_MS = 250; // ~4Hz — plenty for numbers meant to be read, not watched tick

  // Guards only this function's own DOM writes — RollingAverage.push() calls
  // in frame() happen unconditionally every rAF regardless of HUD
  // visibility/throttle state, so samples are never skipped or made stale
  // by this. Likewise the capture path (captureFrames.push in frame()) is
  // untouched by this guard — capture needs every frame's data regardless
  // of HUD visibility, since it's what docs/perf/*.json analysis is built
  // from.
  function updateHud() {
    if (!document.getElementById('perf-hud').classList.contains('open')) return;
    const now = performance.now();
    if (now - lastHudUpdate < HUD_UPDATE_INTERVAL_MS) return;
    lastHudUpdate = now;

    document.getElementById('perf-step-ms').textContent = stepAvg.mean().toFixed(2);
    document.getElementById('perf-render-ms').textContent = renderAvg.mean().toFixed(2);
    document.getElementById('perf-fft-fwd-ms').textContent =
      fftFwdAvg.values.length === 0 ? 'n/a' : fftFwdAvg.mean().toFixed(2);
    document.getElementById('perf-multiply-ms').textContent =
      multiplyAvg.values.length === 0 ? 'n/a' : multiplyAvg.mean().toFixed(2);
    document.getElementById('perf-fft-inv-ms').textContent =
      fftInvAvg.values.length === 0 ? 'n/a' : fftInvAvg.mean().toFixed(2);
    document.getElementById('perf-growth-ms').textContent =
      growthAvg.values.length === 0 ? 'n/a' : growthAvg.mean().toFixed(2);
    document.getElementById('perf-gpu-ms').textContent =
      gpuAvg.values.length === 0 ? 'n/a' : gpuAvg.mean().toFixed(2);
    document.getElementById('perf-frame-ms').textContent = frameAvg.mean().toFixed(2);
    document.getElementById('perf-active-bbox').textContent = lastActiveBbox
      ? `${lastActiveBbox.w}x${lastActiveBbox.h} (${(lastActiveBbox.fraction * 100).toFixed(1)}%)${lastVacuumGrows ? ' [vacuum grows]' : ''}`
      : lastVacuumGrows
        ? 'empty [vacuum grows]'
        : 'empty';
    document.getElementById('perf-step-mode').textContent =
      lastStepMode === 2 && lastCurrentWindow
        ? `windowed ${lastCurrentWindow.w}x${lastCurrentWindow.h}`
        : lastStepMode === 1
          ? 'full grid (cached)'
          : lastStepMode === 0
            ? 'full grid'
            : 'n/a';
    for (const id of ['bass', 'mid', 'treble', 'volume']) {
      document.getElementById(`perf-${id}`).textContent = audioReactiveEnabled
        ? sourceEnvelopes[id].toFixed(3)
        : '-';
    }
  }

  // Originals: MU_MAX = 1.0, SIGMA_MAX = 0.2
  const MU_MAX = 0.5;
  const SIGMA_MAX = 0.05;
  let currentMu = 0.15;
  let currentSigma = 0.014;

  const mapCanvas = document.getElementById('mu-sigma-map');
  const mapCtx = mapCanvas.getContext('2d');
  const mapDot = document.getElementById('mu-sigma-dot');

  const heatmapCanvas = document.createElement('canvas');
  const heatmapCtx = heatmapCanvas.getContext('2d');
  let heatmapCols = 0;
  let heatmapRows = 0;
  let heatmapImage = null;
  let heatmapReady = false;

  const CLASS_COLORS = [
    [51, 51, 51],    // 0 desert - dark gray
    [76, 175, 80],   // 1 savannah - green
    [224, 90, 43],   // 2 chaotic forest - orange/red
    [74, 124, 255],  // 3 complex/life - blue
  ];

  function initHeatmap(cols, rows) {
    heatmapCols = cols;
    heatmapRows = rows;
    heatmapCanvas.width = cols;
    heatmapCanvas.height = rows;
    heatmapImage = heatmapCtx.createImageData(cols, rows);
  }

  function setHeatmapPixel(col, row, classCode) {
    const [r, g, b] = CLASS_COLORS[classCode] || [0, 0, 0];
    const idx = (row * heatmapCols + col) * 4;
    heatmapImage.data[idx] = r;
    heatmapImage.data[idx + 1] = g;
    heatmapImage.data[idx + 2] = b;
    heatmapImage.data[idx + 3] = 255;
  }

  function gridToMuSigma(px, py) {
    const sigma = Math.max(0, Math.min(SIGMA_MAX, (px / mapCanvas.width) * SIGMA_MAX));
    const mu = Math.max(0, Math.min(MU_MAX, MU_MAX - (py / mapCanvas.height) * MU_MAX));
    return [mu, sigma];
  }

  function muSigmaToPoint(mu, sigma) {
    const px = (sigma / SIGMA_MAX) * mapCanvas.width;
    const py = (1 - mu / MU_MAX) * mapCanvas.height;
    return [px, py];
  }

  const muInput = document.getElementById('mu-input');
  const sigmaInput = document.getElementById('sigma-input');

  function updateReadout() {
    // The overlay mu/sigma text readout on the landscape map was removed
    // (it sat bottom-left over the canvas and blocked clicks in that
    // corner) — the number inputs below the map are the only mu/sigma
    // display now.
    // Avoid clobbering the field the user is actively typing in.
    if (document.activeElement !== muInput) muInput.value = currentMu.toFixed(3);
    if (document.activeElement !== sigmaInput) sigmaInput.value = currentSigma.toFixed(4);
  }

  function drawMap() {
    // Landscape heatmap (if any) is drawn by drawLandscapeBackground in a
    // prior step. renderLandscape()'s soft-white-core + prism-fringe glow
    // (see ui-render-helpers.js) is deliberately NOT called here — it's
    // exactly the glow-around-the-marker effect that was asked to be
    // removed; the heatmap alone is enough of a background.
    drawLandscapeBackground();
    const [px, py] = muSigmaToPoint(currentMu, currentSigma);
    const hoverX = px / mapCanvas.width;
    const hoverY = py / mapCanvas.height;
    // The marker itself is a DOM element (.lf-dot, positioned by
    // percentage) rather than canvas-drawn, per DESIGN_SPEC.md — its
    // former prism box-shadow halo was removed per an earlier request.
    mapDot.style.left = `${hoverX * 100}%`;
    mapDot.style.top = `${hoverY * 100}%`;
  }

  function drawLandscapeBackground() {
    if (!heatmapReady) {
      mapCtx.fillStyle = '#222';
      mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
      return;
    }
    heatmapCtx.putImageData(heatmapImage, 0, 0);
    mapCtx.imageSmoothingEnabled = false;
    mapCtx.drawImage(heatmapCanvas, 0, 0, mapCanvas.width, mapCanvas.height);
  }

  let draggingMap = false;

  function setMuSigmaFromEvent(e) {
    const rect = mapCanvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * mapCanvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * mapCanvas.height;
    const [mu, sigma] = gridToMuSigma(px, py);
    currentMu = mu;
    currentSigma = sigma;
    updateReadout();
    drawMap();
    applyParams();
  }

  mapCanvas.addEventListener('pointerdown', (e) => {
    draggingMap = true;
    mapCanvas.setPointerCapture(e.pointerId);
    setMuSigmaFromEvent(e);
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    if (draggingMap) setMuSigmaFromEvent(e);
  });
  mapCanvas.addEventListener('pointerup', () => {
    draggingMap = false;
  });
  mapCanvas.addEventListener('pointercancel', () => {
    draggingMap = false;
  });

  // Landscape heatmaps are always a precomputed static fetch — never live
  // simulation in the browser (that path used to exist as a fallback, see
  // git history, and was removed deliberately: even as a rare fallback it
  // meant computation could fall on the end user's machine, which is
  // exactly what precomputing every reachable combination avoids). The
  // matrix is generated offline by src/bin/gen_landscape.rs across all 3
  // cores x 3 growth functions x a fixed set of radius buckets; radius is
  // snapped to the nearest bucket at fetch time (silently — no "showing an
  // approximation" indicator, by design).
  const LANDSCAPE_RADIUS_BUCKETS = [5, 10, 13, 18, 24, 30];
  let landscapeLoadToken = 0;

  function nearestRadiusBucket(radius) {
    return LANDSCAPE_RADIUS_BUCKETS.reduce((best, b) =>
      Math.abs(b - radius) < Math.abs(best - radius) ? b : best,
    );
  }

  async function loadLandscapeFor(core, growth, radius) {
    const myToken = ++landscapeLoadToken;
    const bucket = nearestRadiusBucket(radius);
    const path = `landscapes/core${core}-growth${growth}-r${bucket}.json`;
    let data;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`status ${res.status}`);
      data = await res.json();
    } catch (err) {
      // Only a genuine network/fetch failure reaches here — every
      // (core, growth, bucket) combination the UI can select is covered by
      // the precomputed matrix, so this is not an "unsupported settings"
      // case, just resilience against a dropped request. Falls back to the
      // one bundled default rather than computing anything locally.
      console.warn(`Failed to load ${path}, falling back to landscape-default.json:`, err);
      try {
        const res = await fetch('landscape-default.json');
        if (!res.ok) throw new Error(`status ${res.status}`);
        data = await res.json();
      } catch (err2) {
        console.warn('Failed to load landscape-default.json fallback:', err2);
        return;
      }
    }
    if (myToken !== landscapeLoadToken) return; // superseded by a newer kernel change
    initHeatmap(data.cols, data.rows);
    for (let row = 0; row < data.rows; row++) {
      for (let col = 0; col < data.cols; col++) {
        setHeatmapPixel(col, row, data.classes[row * data.cols + col]);
      }
    }
    heatmapReady = true;
    document.getElementById('mu-sigma-status').textContent = '';
    drawMap();
  }

  function loadLandscapeForCurrentKernel() {
    const core = parseInt(document.getElementById('kernel-core').value, 10);
    const growth = parseInt(document.getElementById('growth-fn').value, 10);
    const radius = parseInt(document.getElementById('radius-input').value, 10);
    loadLandscapeFor(core, growth, radius);
  }

  let landscapeDebounceHandle = null;

  function scheduleLandscapeReload() {
    clearTimeout(landscapeDebounceHandle);
    landscapeDebounceHandle = setTimeout(loadLandscapeForCurrentKernel, 300);
  }

  function computeGridSize() {
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const pixelH = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    canvas.width = pixelW;
    canvas.height = pixelH;

    // Clamping each axis to MAX_GRID_DIM independently (the old approach)
    // squashes whichever axis hits the cap harder than the other, making
    // cells rectangular instead of square — very visible on tall narrow
    // screens (e.g. an iPhone in portrait: height hits the cap, width
    // doesn't). Scale both axes down by the same factor instead, so
    // whichever axis needs to shrink to fit the cap takes the other one
    // with it and cells stay square.
    const rawGridW = pixelW / CELL_PX;
    const rawGridH = pixelH / CELL_PX;
    const scale = Math.max(1, rawGridW / MAX_GRID_DIM, rawGridH / MAX_GRID_DIM);
    const gridWidth = snapDownToFftFriendlySize(Math.max(1, Math.floor(rawGridW / scale)));
    const gridHeight = snapDownToFftFriendlySize(Math.max(1, Math.floor(rawGridH / scale)));
    return { pixelW, pixelH, gridWidth, gridHeight };
  }

  let { pixelW, pixelH, gridWidth, gridHeight } = computeGridSize();

  const app = new LeniaApp(gridWidth, gridHeight);
  await app.attachCanvas(canvas);

  let activePreset = null; // set when a preset (not a pattern file) is the active state

  async function loadPattern(path) {
    const res = await fetch(path);
    const json = await res.text();
    app.loadPattern(json);
    currentPatternPath = path;
    activePreset = null;
    const parsed = JSON.parse(json);
    currentMu = parsed.mu;
    currentSigma = parsed.sigma;
    updateReadout();
    drawMap();
  }

  await loadPattern(currentPatternPath);

  function frame() {
    const frameStart = performance.now();
    frameAvg.push(frameStart - lastFrameStart);
    lastFrameStart = frameStart;

    if (audioReactiveEnabled) {
      updateAudioReactive();
      updateMiniMeter();
    }

    // The patch modal's own work (numeric meters, A2 bars, cable orb
    // toggling, the A1 spectrum strip — all O(connections)/O(bins), and
    // there can be a lot of connections) doesn't need full display refresh
    // rate; the perf brainstorm doc's own guidance was 30Hz for exactly
    // this kind of view. Deliberately outside the audioReactiveEnabled
    // gate above (unlike updateAudioReactive, which actually drives the
    // sim) — the spectrum's band-edge overlay/handles should stay
    // editable even before the mic is granted; updateAudioPatchMeters()
    // itself is a no-op whenever the modal is closed.
    if (frameStart - lastAudioPatchMeterUpdateAt >= AUDIO_PATCH_METER_INTERVAL_MS) {
      lastAudioPatchMeterUpdateAt = frameStart;
      updateAudioPatchMeters();
    }

    // Split-phase step() calls (four wasm-boundary crossings instead of
    // one) are only worth their overhead while someone's actually looking
    // at the stage breakdown — gate on HUD visibility or an active capture,
    // same as the perf-HUD-closed skip in updateHud().
    const isProfiling = capturing || document.getElementById('perf-hud').classList.contains('open');
    const stepStart = performance.now();
    if (isProfiling) {
      // stepDecideWindow() runs the exact same decision step() itself
      // would (window selection, shrink hysteresis, negative-cache
      // bookkeeping) — calling it here instead of step() means the HUD's
      // stage timings reflect what this frame actually did (windowed vs
      // full-grid), not just the full-grid path unconditionally like
      // before tier 3 item 1's windowing landed. 0/1 = full-grid (scanned
      // / negative-cache-skipped-scan), 2 = windowed — see sim::StepMode.
      const mode = app.stepDecideWindow();
      const windowed = mode === 2;
      const t0 = performance.now();
      if (windowed) app.stepWindowedFftForward();
      else app.stepFftForward();
      const t1 = performance.now();
      if (windowed) app.stepWindowedMultiply();
      else app.stepMultiply();
      const t2 = performance.now();
      if (windowed) app.stepWindowedFftInverse();
      else app.stepFftInverse();
      const t3 = performance.now();
      if (windowed) app.stepWindowedIntegrate();
      else app.stepIntegrate();
      const t4 = performance.now();
      fftFwdAvg.push(t1 - t0);
      multiplyAvg.push(t2 - t1);
      fftInvAvg.push(t3 - t2);
      growthAvg.push(t4 - t3);

      lastStepMode = mode;
      const winInfo = app.currentWindowInfo();
      lastCurrentWindow = winInfo.length === 4 ? { x0: winInfo[0], y0: winInfo[1], w: winInfo[2], h: winInfo[3] } : null;

      const bbox = app.activeBoundingBox(ACTIVE_REGION_EPS_CANDIDATE);
      lastVacuumGrows = app.vacuumGrows();
      if (bbox.length === 4) {
        const [minX, minY, maxX, maxY] = bbox;
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        lastActiveBbox = { w, h, fraction: (w * h) / (gridWidth * gridHeight) };
      } else {
        lastActiveBbox = null;
      }
    } else {
      app.step();
    }
    stepAvg.push(performance.now() - stepStart);

    // Repaint at the held pointer position every frame, not just on
    // pointer events, so holding still without moving keeps reinforcing
    // the stroke against the simulation's own growth/decay dynamics.
    if (painting && lastGridPos) {
      app.paint(lastGridPos[0], lastGridPos[1], brushRadius());
    }

    const renderStart = performance.now();
    app.render();
    renderAvg.push(performance.now() - renderStart);

    const gpuMs = app.lastGpuTimeMs();
    if (!Number.isNaN(gpuMs)) {
      gpuAvg.push(gpuMs);
    }

    updateHud();

    if (capturing) {
      captureFrames.push({
        tMs: frameStart,
        stepMs: stepAvg.values[stepAvg.values.length - 1],
        renderMs: renderAvg.values[renderAvg.values.length - 1],
        gpuMs: Number.isNaN(gpuMs) ? null : gpuMs,
        frameMs: frameAvg.values[frameAvg.values.length - 1],
        fftFwdMs: fftFwdAvg.values[fftFwdAvg.values.length - 1] ?? null,
        multiplyMs: multiplyAvg.values[multiplyAvg.values.length - 1] ?? null,
        fftInvMs: fftInvAvg.values[fftInvAvg.values.length - 1] ?? null,
        growthMs: growthAvg.values[growthAvg.values.length - 1] ?? null,
        activeBboxW: lastActiveBbox?.w ?? null,
        activeBboxH: lastActiveBbox?.h ?? null,
        activeBboxFraction: lastActiveBbox?.fraction ?? null,
        vacuumGrows: lastVacuumGrows,
        stepMode: lastStepMode,
        windowW: lastCurrentWindow?.w ?? null,
        windowH: lastCurrentWindow?.h ?? null,
      });
      if (performance.now() >= captureUntil) {
        capturing = false;
        // Emitted as { meta, frames } rather than a bare array — old
        // capture files under docs/perf/*.json predate this and are a
        // bare array, so anything reading captures off disk needs to
        // handle both shapes going forward.
        const meta = {
          gridWidth,
          gridHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          radius: parseInt(document.getElementById('radius').value, 10),
          kernelCore: parseInt(document.getElementById('kernel-core').value, 10),
          growthFn: parseInt(document.getElementById('growth-fn').value, 10),
          dt: parseFloat(document.getElementById('dt').value),
          activeRegionEpsCandidate: ACTIVE_REGION_EPS_CANDIDATE,
          userAgent: navigator.userAgent,
        };
        console.log(JSON.stringify({ meta, frames: captureFrames }));
        captureFrames = [];
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  let activeBeta = [1.0]; // single-peak kernel; extend to multi-input UI later if needed

  function currentBeta() {
    return activeBeta;
  }

  function applyParams() {
    const dt = parseFloat(document.getElementById('dt').value);
    const growth = parseInt(document.getElementById('growth-fn').value, 10);
    app.setParams(currentMu, currentSigma, dt, growth);
  }

  // Audio-reactive mode: mic input's frequency-band energy nudges sim/
  // shader parameters on top of their slider-set base values, applied
  // fresh every frame while enabled. Which band feeds which parameter
  // (and how strongly) is user-patchable via the Audio Patch HUD instead
  // of a fixed 1:1 mapping — see audioPatch below. currentMu/currentSigma
  // etc. are never mutated by this, so presets/readouts always reflect
  // base values, not a jittering audio-modulated one.
  // Order matters: updateAudioReactive processes these in sequence within
  // a single loop, and D1's pitch detection reads this same frame's
  // freshly-computed sourceEnvelopes.volume as a silence gate — 'volume'
  // must stay ahead of 'pitch' in this array or that reads last frame's
  // value instead.
  const SOURCE_IDS = ['bass', 'mid', 'treble', 'volume', 'pitch'];
  const TARGET_IDS = ['mu', 'sigma', 'aberration', 'radius', 'dt'];
  const SOURCE_LABELS = { bass: 'Bass', mid: 'Mid', treble: 'Treble', volume: 'Volume', pitch: 'Pitch' };
  // Matches ui-render-helpers.js's CABLE_COLORS palette/order (duplicated
  // rather than imported, same tradeoff as that file's own vendored
  // duplications) so a source reads as the same color everywhere it shows
  // up: cable fringe, A1's spectrum overlay/handles. Pitch (D1) isn't part
  // of that 4-color cycle (it's not a cable-fringe color, added later) —
  // amber, the one prism accent color (--ca-o in ui-tokens.css) the other
  // four sources don't already use.
  const SOURCE_COLORS = { bass: '#ff4646', mid: '#5affa0', treble: '#46d1ff', volume: '#c07bff', pitch: '#ffaf46' };
  const TARGET_LABELS = { mu: 'Mu', sigma: 'Sigma', aberration: 'Aberration', radius: 'Radius', dt: 'Dt' };
  // Default gain for a newly-drawn connection, keyed by target — matches
  // each target's natural scale (mu/sigma need tiny nudges, radius needs
  // whole cells) so a fresh cable does something reasonable before tuning.
  const DEFAULT_GAIN_BY_TARGET = { mu: 0.07, sigma: 0.007, aberration: 2.0, radius: 10, dt: 0.05 };
  // dt directly scales how much each step's growth term gets integrated
  // into the state — unlike mu/sigma (which just fade the pattern out) or
  // radius (expensive but not unstable), pushing dt too high makes the
  // simulation visibly blow out into flicker/noise. Clamp the *effective*
  // (base + nudge) dt to a tighter range than the slider's full 0.01-1,
  // so an audio transient can't drive it into that unstable territory
  // regardless of how the connection gain gets tuned.
  const DT_EFFECTIVE_MIN = 0.02;
  const DT_EFFECTIVE_MAX = 0.6;
  const AUDIO_PATCH_STORAGE_KEY = 'lenia-audio-patch';

  function defaultAudioPatch() {
    return {
      bands: {
        bass: { lo: 20, hi: 250, smoothing: 0.25 },
        mid: { lo: 250, hi: 2000, smoothing: 0.25 },
        treble: { lo: 2000, hi: 8000, smoothing: 0.25 },
        volume: { lo: 20, hi: 12000, smoothing: 0.25 },
        // D1: lo/hi here double as both the argmax search range and the
        // log-frequency mapping range (see findDominantPitchHz) — a
        // typical lead-melody fundamental range, not a level-averaging
        // band like the other four. hold: true by default — without it
        // the pitch reading collapses to whatever noise happens to peak
        // during silence between notes, which is exactly the "musical vs
        // useless" distinction the brainstorm doc calls out.
        pitch: { lo: 80, hi: 2000, smoothing: 0.25, hold: true },
      },
      connections: [
        { id: 'c-bass-mu', source: 'bass', target: 'mu', gain: DEFAULT_GAIN_BY_TARGET.mu },
        { id: 'c-treble-sigma', source: 'treble', target: 'sigma', gain: DEFAULT_GAIN_BY_TARGET.sigma },
        { id: 'c-mid-aberration', source: 'mid', target: 'aberration', gain: DEFAULT_GAIN_BY_TARGET.aberration },
        { id: 'c-volume-radius', source: 'volume', target: 'radius', gain: DEFAULT_GAIN_BY_TARGET.radius },
      ],
      // depth/muted: C4 master depth + panic mute (audio-visualization-
      // brainstorm.md) — applied once in computeTargetDeltas, nowhere else.
      global: {
        adaptFloorRise: 0.002,
        adaptCeilFall: 0.01,
        radiusDebounceMs: 200,
        depth: 100,
        muted: false,
      },
    };
  }

  function loadAudioPatch() {
    const defaults = defaultAudioPatch();
    try {
      const raw = localStorage.getItem(AUDIO_PATCH_STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        bands: { ...defaults.bands, ...parsed.bands },
        connections: Array.isArray(parsed.connections) ? parsed.connections : defaults.connections,
        global: { ...defaults.global, ...parsed.global },
      };
    } catch {
      return defaults;
    }
  }

  function saveAudioPatch() {
    localStorage.setItem(AUDIO_PATCH_STORAGE_KEY, JSON.stringify(audioPatch));
  }

  const audioPatch = loadAudioPatch();

  let audioReactiveEnabled = false;
  const AUDIO_PATCH_METER_INTERVAL_MS = 1000 / 30;
  let lastAudioPatchMeterUpdateAt = 0;
  let audioStream = null;
  let audioCtx = null;
  let analyser = null;
  let analyserData = null;
  let lastAppliedRadius = null;
  let lastRadiusRebuildAt = 0;

  const sourceBinRanges = { bass: [0, 0], mid: [0, 0], treble: [0, 0], volume: [0, 0], pitch: [0, 0] };
  const sourceEnvelopes = { bass: 0, mid: 0, treble: 0, volume: 0, pitch: 0 };
  // getByteFrequencyData maps a fixed dB window (analyser default: -100dB
  // to -30dB) linearly to 0-255 for every bin. Real audio has far less
  // absolute energy in some bands than others (e.g. treble vs bass), so
  // a band can sit consistently low in that fixed window even at full
  // volume — no single global scale factor makes every band equally
  // responsive. Instead, track each band's own observed floor/ceiling and
  // normalize against that (the floor rises slowly to forget old noise,
  // the ceiling falls slowly to forget old peaks, both snap instantly
  // toward new extremes), so each band uses its own full 0-1 range
  // regardless of its natural absolute energy level.
  //
  // pitch is deliberately excluded from this adaptive scheme (fixed at
  // {floor:0, ceil:1}, never updated — see resetSourceRange): its raw
  // value is already a clean 0..1 log-frequency mapping (findDominantPitchHz),
  // and adapting a floor/ceiling on top of that would make the melody
  // mapping drift with how much pitch variation happened recently instead
  // of staying a stable, predictable Hz->0..1 curve.
  const sourceRanges = {
    bass: { floor: 1, ceil: 0 },
    mid: { floor: 1, ceil: 0 },
    treble: { floor: 1, ceil: 0 },
    volume: { floor: 1, ceil: 0 },
    pitch: { floor: 0, ceil: 1 },
  };

  // A2 (docs/design/audio-visualization-brainstorm.md): per-source meter
  // peak-hold + clip-LED state, decoupled from sourceRanges (the adaptive
  // floor/ceiling used to drive the sim) since these are purely for the
  // patch modal's meters and reset independently of it.
  const meterPeak = { bass: 0, mid: 0, treble: 0, volume: 0, pitch: 0 };
  const meterPeakAt = { bass: 0, mid: 0, treble: 0, volume: 0, pitch: 0 };
  const meterClipUntil = { bass: 0, mid: 0, treble: 0, volume: 0, pitch: 0 };
  const METER_PEAK_HOLD_MS = 2000;
  const METER_PEAK_DECAY = 0.94; // per meter tick, once the hold expires
  const METER_CLIP_THRESHOLD = 0.995; // adaptiveNormalize saturates at 1.0
  const METER_CLIP_HOLD_MS = 300; // makes a clip visible even if only hit for one tick

  // B2 (audio-visualization-brainstorm.md): ~10s scrolling envelope
  // history per source. Written at the modal's own ~30Hz tick (not every
  // rAF frame) specifically because 300 samples / 30Hz = 10s is the budget
  // the doc sized this at — writing every frame instead would only cover
  // ~5s of history at 60Hz. One shared write index since all 4 sources
  // advance in lockstep; reading the buffer chronologically (oldest to
  // newest) starts from this same index, wrapping around.
  const HISTORY_LENGTH = 300;
  const sourceHistory = {
    bass: new Float32Array(HISTORY_LENGTH),
    mid: new Float32Array(HISTORY_LENGTH),
    treble: new Float32Array(HISTORY_LENGTH),
    volume: new Float32Array(HISTORY_LENGTH),
    pitch: new Float32Array(HISTORY_LENGTH),
  };
  let historyWriteIndex = 0;

  // B3: freezes the patch modal's meters + adaptive-normalization tracking
  // for inspection, without affecting the sim (audio still drives targets
  // underneath — see the `!audioPatchFrozen` guard in adaptiveNormalize).
  let audioPatchFrozen = false;

  function hzToBinRange(loHz, hiHz, sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    const lo = Math.max(0, Math.floor(loHz / binHz));
    const hi = Math.min(fftSize / 2 - 1, Math.ceil(hiHz / binHz));
    return [lo, hi];
  }

  function bandAverage(data, [lo, hi]) {
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += data[i];
    return sum / (hi - lo + 1) / 255;
  }

  function adaptiveNormalize(sample, range) {
    // Frozen (B3): stop the floor/ceiling from tracking so the modal's
    // reading holds still, but keep computing the envelope below from the
    // frozen span — the sim keeps reacting underneath the frozen picture.
    if (!audioPatchFrozen) {
      if (sample < range.floor) range.floor = sample;
      else range.floor += (sample - range.floor) * audioPatch.global.adaptFloorRise;

      if (sample > range.ceil) range.ceil = sample;
      else range.ceil += (sample - range.ceil) * audioPatch.global.adaptCeilFall;
    }

    const span = range.ceil - range.floor;
    return span > 1e-4 ? Math.min(1, Math.max(0, (sample - range.floor) / span)) : 0;
  }

  function recomputeSourceBinRange(id) {
    if (!audioCtx || !analyser) return;
    const band = audioPatch.bands[id];
    sourceBinRanges[id] = hzToBinRange(band.lo, band.hi, audioCtx.sampleRate, analyser.fftSize);
  }

  // Resets one source's adaptive range back to its "not yet locked onto
  // anything" sentinel (floor=1, ceil=0 — both snap on the very next
  // sample, see adaptiveNormalize) after something changes what its raw
  // reading means (band edges moved, dB window changed, audio just
  // (re)enabled). pitch is excluded: its range is a fixed {floor:0,
  // ceil:1} that adaptiveNormalize never even runs against (see
  // updateAudioReactive), so there's nothing to re-lock.
  function resetSourceRange(id) {
    if (id === 'pitch') return;
    sourceRanges[id].floor = 1;
    sourceRanges[id].ceil = 0;
  }

  // D1 (audio-visualization-brainstorm.md): dominant-frequency follower.
  // Finds the loudest bin within [loBin, hiBin], then refines it to
  // sub-bin precision via parabolic interpolation over the bin and its two
  // neighbors — standard spectral peak-picking technique. Works directly
  // on the raw dB-mapped bytes getByteFrequencyData returns (no separate
  // log conversion needed, they're already on a log/dB scale).
  //
  // Also returns `prominence` (peak minus the range's own average) instead
  // of just the peak's raw magnitude: an *absolute* magnitude threshold
  // doesn't distinguish silence from noise, because the argmax over ~80+
  // bins of flat noise is an order statistic that's reliably elevated
  // above any single bin's typical value regardless of how quiet the room
  // actually is — silence still "wins" a peak somewhere every frame. That
  // picked-at-random bin then bounced around the whole search range frame
  // to frame, and smoothing a value that random-walks across the full
  // range converges toward its middle — which is exactly the "hovers
  // around the center with no song playing" bug this replaced. Prominence
  // asks the right question instead: does this bin actually stick up
  // above its neighborhood, the way a real tonal peak does and noise
  // doesn't.
  function findDominantPitchHz(data, [loBin, hiBin]) {
    let bestBin = loBin;
    let bestVal = -1;
    let sum = 0;
    for (let i = loBin; i <= hiBin; i++) {
      sum += data[i];
      if (data[i] > bestVal) {
        bestVal = data[i];
        bestBin = i;
      }
    }
    const avg = sum / (hiBin - loBin + 1);
    let interpBin = bestBin;
    if (bestBin > loBin && bestBin < hiBin) {
      const yMinus = data[bestBin - 1];
      const y0 = data[bestBin];
      const yPlus = data[bestBin + 1];
      const denom = yMinus - 2 * y0 + yPlus;
      if (denom !== 0) {
        const d = 0.5 * (yMinus - yPlus) / denom;
        interpBin = bestBin + Math.max(-0.5, Math.min(0.5, d));
      }
    }
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    return { hz: interpBin * binHz, prominence: bestVal - avg };
  }

  // Log-frequency map to 0..1 — same construction as A1's spectrum axis
  // (spectrumHzToX), just outputting a unit value instead of a pixel
  // column, so equal *musical* intervals (octaves) move the mapped value
  // by equal amounts regardless of where in [loHz, hiHz] they fall.
  function hzToUnit(hz, loHz, hiHz) {
    const clamped = Math.min(hiHz, Math.max(loHz, hz));
    return Math.log(clamped / loHz) / Math.log(hiHz / loHz);
  }

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function hzToNoteName(hz) {
    if (!(hz > 0)) return '--';
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    const name = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${name}${octave}`;
  }

  // Below this much prominence (peak bin minus the search range's own
  // average, in byte units 0-255), the "loudest bin in range" doesn't
  // actually stand out from its neighborhood — just noise-floor texture,
  // not a real tonal peak. Empirical starting point, not derived from
  // anything; revisit if pitch reads as jumpy on quiet material or too
  // sticky on percussive/noisy material.
  const PITCH_PROMINENCE_THRESHOLD = 20;
  // Real mic noise floors aren't flat white noise — hum, mic self-noise,
  // and room resonances all create bumps that can look locally
  // "prominent" even in a silent room, so prominence alone still let
  // pitch drift on structured-but-not-musical noise. This second,
  // independent gate requires the Volume source's own (already
  // adaptively-normalized, already visible) envelope to also clear a
  // floor — quiet noise essentially never also clears a loudness gate the
  // way real music does. Both conditions must hold for a detection to
  // count as real (see the SOURCE_IDS ordering comment for why this can
  // read this frame's volume envelope).
  const PITCH_VOLUME_GATE = 0.08;
  // The Hz value currently driving the pitch envelope — whichever is more
  // recent, a fresh detection or (while holding through silence) the last
  // real one. Read by both updateAudioReactive (to compute the envelope)
  // and the meter display (Hz + note name).
  let currentPitchHz = 0;

  async function acquireMicStream() {
    // Voice-call processing (echo cancellation, noise suppression,
    // auto-gain) is tuned around speech and can suppress or distort
    // content outside that band — we want a more neutral signal to
    // analyze music/ambient sound across the full spectrum.
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }

  async function enableAudioReactive() {
    audioStream = await acquireMicStream();
    // The user can revoke access mid-session by disconnecting/disabling
    // the mic device, which ends the track without us calling
    // disableAudioReactive, so the checkbox and internal state would
    // otherwise get stuck "on" with a dead stream.
    audioStream.getTracks().forEach((t) => {
      t.onended = () => {
        const checkbox = document.getElementById('audio-reactive-enabled');
        checkbox.checked = false;
        syncCheckActive(checkbox);
        disableAudioReactive();
      };
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(audioStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    // AnalyserNode smooths its own output across calls by default
    // (smoothingTimeConstant defaults to 0.8); we already run our own
    // envelope smoothing below, so leave this raw to avoid compounding
    // two smoothing stages into a much slower, flatter response.
    analyser.smoothingTimeConstant = 0;
    // Deliberately not connected to audioCtx.destination — we only read
    // frequency data; routing the mic to output would cause feedback/echo.
    source.connect(analyser);
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    for (const id of SOURCE_IDS) {
      recomputeSourceBinRange(id);
      sourceEnvelopes[id] = 0;
      resetSourceRange(id);
    }
    currentPitchHz = 0;
    lastAppliedRadius = null;
    lastRadiusRebuildAt = 0;
    audioReactiveEnabled = true;
    rebuildSpectrumLUT(); // A1: needs analyser.fftSize/audioCtx.sampleRate, both just set above
  }

  function disableAudioReactive() {
    audioReactiveEnabled = false;
    if (audioStream) {
      audioStream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      audioStream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    analyser = null;
    analyserData = null;
    spectrumBinToX = null;
    spectrumColumnMax = null;
    spectrumPeaks = null;
    for (const id of SOURCE_IDS) sourceEnvelopes[id] = 0;
    currentPitchHz = 0;
    applyParams(); // restore un-nudged base mu/sigma
    applyKernel(); // restore un-nudged base radius
    app.setAberrationMult(1.0); // restore un-nudged base aberration
  }

  // Sums each connection's (source envelope * gain) into its target, so
  // a target fed by multiple cables gets their combined contribution.
  // C4: muted returns all-zero deltas outright — targets hold their base
  // values while sourceEnvelopes/meters/spectrum keep updating normally,
  // so the modal still shows the signal arriving even while muted (that's
  // the visual confirmation that muting actually worked). depth is a
  // single multiplier on every connection's contribution, like a
  // mod-wheel amount on the whole matrix.
  function computeTargetDeltas() {
    const deltas = { mu: 0, sigma: 0, aberration: 0, radius: 0, dt: 0 };
    if (audioPatch.global.muted) return deltas;
    const depthMult = audioPatch.global.depth / 100;
    for (const conn of audioPatch.connections) {
      deltas[conn.target] += sourceEnvelopes[conn.source] * conn.gain * depthMult;
    }
    return deltas;
  }

  function updateAudioReactive() {
    analyser.getByteFrequencyData(analyserData);
    for (const id of SOURCE_IDS) {
      const band = audioPatch.bands[id];
      let normalized;
      if (id === 'pitch') {
        // D1: bypasses bandAverage/adaptiveNormalize entirely — a single
        // dominant frequency, not a level, and already a clean 0..1 via
        // hzToUnit rather than something needing floor/ceil adaptation
        // (see the sourceRanges.pitch comment above for why).
        const { hz, prominence } = findDominantPitchHz(analyserData, sourceBinRanges.pitch);
        const hasRealPeak = prominence >= PITCH_PROMINENCE_THRESHOLD && sourceEnvelopes.volume >= PITCH_VOLUME_GATE;
        if (hasRealPeak || !band.hold) {
          currentPitchHz = hz;
        } // else: no real peak (silence/noise) + hold on — keep the last detected Hz
        normalized = hzToUnit(currentPitchHz, band.lo, band.hi);
      } else {
        const raw = bandAverage(analyserData, sourceBinRanges[id]);
        normalized = adaptiveNormalize(raw, sourceRanges[id]);
      }
      const smoothing = band.smoothing;
      sourceEnvelopes[id] = sourceEnvelopes[id] * smoothing + normalized * (1 - smoothing);
    }

    const deltas = computeTargetDeltas();

    const baseDt = parseFloat(document.getElementById('dt').value);
    const growth = parseInt(document.getElementById('growth-fn').value, 10);
    const mu = Math.min(MU_MAX, Math.max(0, currentMu + deltas.mu));
    const sigma = Math.min(SIGMA_MAX, Math.max(0, currentSigma + deltas.sigma));
    const dt = Math.min(DT_EFFECTIVE_MAX, Math.max(DT_EFFECTIVE_MIN, baseDt + deltas.dt));
    app.setParams(mu, sigma, dt, growth);

    app.setAberrationMult(Math.max(0, 1.0 + deltas.aberration));

    // Radius changes trigger a full kernel-FFT rebuild (unlike setParams,
    // which is a cheap field assignment) — only actually rebuild when the
    // rounded target radius has changed AND enough time has passed since
    // the last rebuild, so a continuously-fluctuating source doesn't
    // hammer the FFT every frame.
    const baseRadius = parseInt(document.getElementById('radius').value, 10);
    const desiredRadius = Math.round(Math.min(30, Math.max(2, baseRadius + deltas.radius)));
    const now = performance.now();
    if (desiredRadius !== lastAppliedRadius && now - lastRadiusRebuildAt >= audioPatch.global.radiusDebounceMs) {
      const core = parseInt(document.getElementById('kernel-core').value, 10);
      app.setKernel(desiredRadius, core, currentBeta());
      lastAppliedRadius = desiredRadius;
      lastRadiusRebuildAt = now;
    }
  }

  // Audio Patch HUD: a connect-the-dots node graph for rewiring which
  // frequency band drives which parameter, and tuning everything above
  // (per-band Hz range/smoothing, per-connection gain, global adapt
  // rates, radius debounce) without editing code.
  const audioPatchModal = document.getElementById('audio-patch-modal');
  const audioPatchSourcesEl = document.getElementById('audio-patch-sources');
  const audioPatchTargetsEl = document.getElementById('audio-patch-targets');
  const audioPatchSvg = document.getElementById('audio-patch-svg');
  const audioPatchConnectionsEl = document.getElementById('audio-patch-connections');
  const audioPatchGlobalEl = document.getElementById('audio-patch-global');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // A1 (audio-visualization-brainstorm.md): spectrum analyzer with
  // draggable band edges for bass/mid/treble (volume spans nearly the
  // whole axis by design — a draggable overlay for it wouldn't mean
  // anything, so it stays editable only via the existing lo/hi number
  // inputs). Reuses the same per-frame analyserData snapshot
  // updateAudioReactive() already captures — no new audio work.
  const spectrumCanvas = document.getElementById('audio-spectrum');
  const spectrumCtx = spectrumCanvas.getContext('2d');
  const SPECTRUM_AXIS_LO_HZ = 20;
  const SPECTRUM_AXIS_HI_HZ = 20000;
  const SPECTRUM_DRAGGABLE_BANDS = ['bass', 'mid', 'treble'];
  const SPECTRUM_HANDLES = SPECTRUM_DRAGGABLE_BANDS.flatMap((id) => [
    { id, field: 'lo' },
    { id, field: 'hi' },
  ]);
  const SPECTRUM_HANDLE_HIT_PX = 8; // in canvas-internal pixels (0..600), not CSS pixels
  const SPECTRUM_PEAK_DECAY = 0.96; // per draw tick (~30Hz, see updateAudioPatchMeters)
  // B4: landmark note markers so the axis reads as pitch, not just raw Hz
  // ("is 250 between C3 and C4?") — the octave A's (standard 12-tone equal
  // temperament, A4 = 440Hz) are a natural, memorable choice of gridline
  // since A4 is the tuning reference most people already know.
  const SPECTRUM_NOTE_HZ = [27.5, 55, 110, 220, 440, 880, 1760, 3520, 7040, 14080];
  const SPECTRUM_NOTE_LABELS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9'];

  // log-frequency axis mapping — independent of the analyser (sampleRate,
  // fftSize), so band overlay/handles can draw and be dragged even before
  // the mic is enabled. Only the live bars below need the analyser.
  function spectrumHzToX(hz) {
    const clamped = Math.min(SPECTRUM_AXIS_HI_HZ, Math.max(SPECTRUM_AXIS_LO_HZ, hz));
    return (spectrumCanvas.width * Math.log(clamped / SPECTRUM_AXIS_LO_HZ)) / Math.log(SPECTRUM_AXIS_HI_HZ / SPECTRUM_AXIS_LO_HZ);
  }
  function spectrumXToHz(x) {
    const t = Math.min(1, Math.max(0, x / spectrumCanvas.width));
    return SPECTRUM_AXIS_LO_HZ * Math.exp(t * Math.log(SPECTRUM_AXIS_HI_HZ / SPECTRUM_AXIS_LO_HZ));
  }
  function snapSpectrumHz(hz) {
    const step = hz < 200 ? 5 : hz < 2000 ? 25 : 100;
    return Math.max(SPECTRUM_AXIS_LO_HZ, Math.round(hz / step) * step);
  }
  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // Replaces a <input type="number">'s native spin-button arrows with a
  // small "knob" strip (a repeating-line texture, see style.css) that's
  // dragged vertically or scrolled to step the value — used across both
  // the Lenia field menu and the audio patch modal. Generic: reads
  // min/max/step off the input's own attributes and dispatches real
  // 'input'+'change' events, so it's a drop-in for any number input
  // that's already wired to one of those (every one of them, here).
  // Wraps the input in a new element rather than positioning the knob
  // over it — the input keeps its own border/background/font rules
  // untouched; only the wrap's width takes over the input's old
  // width/sizing role (see the .lf-knob-wrap rules in style.css for the
  // few contexts that set an explicit width).
  const KNOB_DRAG_PX_PER_STEP = 6;

  function attachNumberKnob(input) {
    const wrap = document.createElement('span');
    wrap.className = 'lf-knob-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const knob = document.createElement('span');
    knob.className = 'lf-knob';
    knob.setAttribute('aria-hidden', 'true');
    knob.title = 'Drag or scroll to adjust';
    wrap.appendChild(knob);

    function stepDecimals() {
      const step = String(parseFloat(input.step) || 1);
      const dot = step.indexOf('.');
      return dot === -1 ? 0 : step.length - dot - 1;
    }

    function setValue(raw) {
      const step = parseFloat(input.step) || 1;
      const min = input.min !== '' ? parseFloat(input.min) : -Infinity;
      const max = input.max !== '' ? parseFloat(input.max) : Infinity;
      let v = Math.min(max, Math.max(min, raw));
      v = Math.round(v / step) * step;
      v = parseFloat(v.toFixed(stepDecimals())); // trims float noise from the round/divide above
      if (String(v) === input.value) return;
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let dragStartY = null;
    let dragStartValue = 0;

    knob.addEventListener('pointerdown', (e) => {
      dragStartY = e.clientY;
      dragStartValue = parseFloat(input.value) || 0;
      knob.setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection / focus fight while dragging
    });
    knob.addEventListener('pointermove', (e) => {
      if (dragStartY === null) return;
      const step = parseFloat(input.step) || 1;
      const deltaSteps = (dragStartY - e.clientY) / KNOB_DRAG_PX_PER_STEP;
      setValue(dragStartValue + deltaSteps * step);
    });
    knob.addEventListener('pointerup', () => {
      dragStartY = null;
    });
    knob.addEventListener('pointercancel', () => {
      dragStartY = null;
    });
    knob.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const step = parseFloat(input.step) || 1;
        setValue((parseFloat(input.value) || 0) + (e.deltaY < 0 ? step : -step));
      },
      { passive: false },
    );
  }

  // B4: note-name axis notches, as real DOM elements below the canvas
  // rather than drawn onto it — positions are static (percentage of the
  // fixed axis, independent of any live data) so this builds once here
  // instead of running in drawSpectrum()'s per-tick redraw.
  const spectrumAxisEl = document.getElementById('audio-spectrum-axis');
  function buildSpectrumAxisLabels() {
    spectrumAxisEl.innerHTML = '';
    for (let i = 0; i < SPECTRUM_NOTE_HZ.length; i++) {
      const hz = SPECTRUM_NOTE_HZ[i];
      if (hz < SPECTRUM_AXIS_LO_HZ || hz > SPECTRUM_AXIS_HI_HZ) continue;
      const notch = document.createElement('div');
      notch.className = 'lf-spectrum-note';
      notch.style.left = `${(spectrumHzToX(hz) / spectrumCanvas.width) * 100}%`;
      notch.textContent = SPECTRUM_NOTE_LABELS[i];
      spectrumAxisEl.appendChild(notch);
    }
  }
  buildSpectrumAxisLabels();

  // bin->column lookup (forward: bin index -> canvas x column), rebuilt
  // only when the analyser (re)initializes — trig stays out of the
  // per-tick draw, which then just does O(bins) array compares + O(width)
  // fillRects, per the doc's stated budget.
  let spectrumBinToX = null; // Int32Array(binCount); -1 for bins below the axis floor
  let spectrumColumnMax = null; // Float32Array(width), scratch buffer reused every tick
  let spectrumPeaks = null; // Float32Array(width), slow-decay peak-hold trace

  function rebuildSpectrumLUT() {
    if (!analyser || !audioCtx) return;
    const binCount = analyser.frequencyBinCount;
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    const width = spectrumCanvas.width;
    spectrumBinToX = new Int32Array(binCount);
    for (let i = 0; i < binCount; i++) {
      const hz = i * binHz;
      spectrumBinToX[i] = hz < SPECTRUM_AXIS_LO_HZ ? -1 : Math.min(width - 1, Math.floor(spectrumHzToX(hz)));
    }
    spectrumColumnMax = new Float32Array(width);
    spectrumPeaks = new Float32Array(width);
  }

  let spectrumDragHandle = null; // one entry (by reference) from SPECTRUM_HANDLES, or null

  function spectrumEventX(e) {
    const rect = spectrumCanvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * spectrumCanvas.width;
  }

  function findSpectrumHandleAt(x) {
    let closest = null;
    let closestDist = SPECTRUM_HANDLE_HIT_PX;
    for (const h of SPECTRUM_HANDLES) {
      const dist = Math.abs(spectrumHzToX(audioPatch.bands[h.id][h.field]) - x);
      if (dist < closestDist) {
        closestDist = dist;
        closest = h;
      }
    }
    return closest;
  }

  function applySpectrumDrag(e) {
    if (!spectrumDragHandle) return;
    const { id, field } = spectrumDragHandle;
    const hz = snapSpectrumHz(spectrumXToHz(spectrumEventX(e)));
    const band = audioPatch.bands[id];
    if (field === 'lo') band.lo = Math.min(hz, band.hi - 10);
    else band.hi = Math.max(hz, band.lo + 10);
    recomputeSourceBinRange(id);
    resetSourceRange(id);
    saveAudioPatch();
    const inputRefs = bandInputRefs[id];
    if (inputRefs) {
      inputRefs.lo.value = band.lo;
      inputRefs.hi.value = band.hi;
    }
  }

  spectrumCanvas.addEventListener('pointerdown', (e) => {
    const handle = findSpectrumHandleAt(spectrumEventX(e));
    if (!handle) return;
    spectrumDragHandle = handle;
    spectrumCanvas.style.cursor = 'ew-resize';
    spectrumCanvas.setPointerCapture(e.pointerId);
    applySpectrumDrag(e);
  });
  spectrumCanvas.addEventListener('pointermove', (e) => {
    if (spectrumDragHandle) {
      applySpectrumDrag(e);
    } else {
      // Hover feedback: ew-resize over a draggable band edge, default
      // elsewhere — cheap (one hit-test already used for drag start),
      // only runs while the pointer is actually over the canvas.
      spectrumCanvas.style.cursor = findSpectrumHandleAt(spectrumEventX(e)) ? 'ew-resize' : 'default';
    }
  });
  spectrumCanvas.addEventListener('pointerup', () => {
    spectrumDragHandle = null;
    spectrumCanvas.style.cursor = 'default';
  });
  spectrumCanvas.addEventListener('pointercancel', () => {
    spectrumDragHandle = null;
    spectrumCanvas.style.cursor = 'default';
  });
  spectrumCanvas.addEventListener('pointerleave', () => {
    if (!spectrumDragHandle) spectrumCanvas.style.cursor = 'default';
  });

  function drawSpectrum() {
    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    spectrumCtx.clearRect(0, 0, width, height);

    for (const id of SPECTRUM_DRAGGABLE_BANDS) {
      const band = audioPatch.bands[id];
      const x0 = spectrumHzToX(band.lo);
      const x1 = spectrumHzToX(band.hi);
      spectrumCtx.fillStyle = hexToRgba(SOURCE_COLORS[id], 0.12);
      spectrumCtx.fillRect(x0, 0, x1 - x0, height);
    }

    if (analyser && spectrumBinToX) {
      spectrumColumnMax.fill(0);
      for (let i = 0; i < analyserData.length; i++) {
        const col = spectrumBinToX[i];
        if (col < 0) continue;
        const v = analyserData[i] / 255;
        if (v > spectrumColumnMax[col]) spectrumColumnMax[col] = v;
      }
      for (let x = 0; x < width; x++) {
        if (spectrumColumnMax[x] > spectrumPeaks[x]) spectrumPeaks[x] = spectrumColumnMax[x];
        else spectrumPeaks[x] *= SPECTRUM_PEAK_DECAY;
      }
      spectrumCtx.fillStyle = 'rgba(233,233,230,0.18)';
      for (let x = 0; x < width; x++) {
        const h = spectrumPeaks[x] * height;
        if (h > 0.5) spectrumCtx.fillRect(x, height - h, 1, h);
      }
      spectrumCtx.fillStyle = 'rgba(233,233,230,0.85)';
      for (let x = 0; x < width; x++) {
        const h = spectrumColumnMax[x] * height;
        if (h > 0.5) spectrumCtx.fillRect(x, height - h, 1, h);
      }
    }

    spectrumCtx.lineWidth = 1;
    for (const h of SPECTRUM_HANDLES) {
      const x = spectrumHzToX(audioPatch.bands[h.id][h.field]);
      spectrumCtx.globalAlpha = h === spectrumDragHandle ? 1 : 0.6;
      spectrumCtx.strokeStyle = SOURCE_COLORS[h.id];
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(x + 0.5, 0);
      spectrumCtx.lineTo(x + 0.5, height);
      spectrumCtx.stroke();
    }
    spectrumCtx.globalAlpha = 1;
  }

  function nextConnectionId() {
    return `c${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  function addConnection(sourceId, targetId) {
    // Avoid an exact duplicate pair — re-dragging the same source->target
    // combo would otherwise silently create a second identical cable.
    const exists = audioPatch.connections.some((c) => c.source === sourceId && c.target === targetId);
    if (exists) return;
    audioPatch.connections.push({
      id: nextConnectionId(),
      source: sourceId,
      target: targetId,
      gain: DEFAULT_GAIN_BY_TARGET[targetId] ?? 1,
    });
    saveAudioPatch();
    buildConnectionsList();
    redrawCables();
  }

  function removeConnection(id) {
    audioPatch.connections = audioPatch.connections.filter((c) => c.id !== id);
    saveAudioPatch();
    buildConnectionsList();
    redrawCables();
  }

  function portCenter(portEl) {
    const portRect = portEl.getBoundingClientRect();
    const svgRect = audioPatchSvg.getBoundingClientRect();
    return {
      x: portRect.left + portRect.width / 2 - svgRect.left,
      y: portRect.top + portRect.height / 2 - svgRect.top,
    };
  }

  function cablePath(p1, p2) {
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
  }

  // B1 (audio-visualization-brainstorm.md): cached per-connection orb-group
  // refs, rebuilt only on structure changes (redrawCables), so the flow
  // animation's per-tick update (below) never touches path data or does a
  // querySelector — just a CSS custom property + per-orb opacity on
  // already-found nodes.
  const cableFlowRefs = {};

  function redrawCables() {
    audioPatchSvg.innerHTML = '';
    for (const id in cableFlowRefs) delete cableFlowRefs[id];
    ensureCableFilter(audioPatchSvg, SVG_NS);
    // Reset once per full redraw, not per cable — otherwise the fringe
    // color pairing would drift on every add/remove instead of always
    // starting from the same sequence (see ui-render-helpers.js).
    resetCableColorCycle();
    for (const conn of audioPatch.connections) {
      const sourcePort = audioPatchSourcesEl.querySelector(`[data-port="source"][data-id="${conn.source}"]`);
      const targetPort = audioPatchTargetsEl.querySelector(`[data-port="target"][data-id="${conn.target}"]`);
      if (!sourcePort || !targetPort) continue;
      const p1 = portCenter(sourcePort);
      const p2 = portCenter(targetPort);

      // renderCable() draws the prism-fringed look but has no click
      // target of its own (its core path is only ~1px wide) — add a
      // wide invisible hit path into the same group for reliable
      // click-to-delete.
      const g = renderCable(SVG_NS, p1.x, p1.y, p2.x, p2.y);
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', cablePath(p1, p2));
      hit.setAttribute('class', 'lf-cable-hit');
      hit.addEventListener('click', () => removeConnection(conn.id));
      g.prepend(hit);
      audioPatchSvg.appendChild(g);
      cableFlowRefs[conn.id] = {
        group: g.querySelector('.lf-cable-orbs'),
        orbs: g.querySelectorAll('.lf-cable-orb'),
      };
    }
  }

  // Adaptive normalization (see adaptiveNormalize) tracks *relative*
  // variance, not absolute level — a genuinely silent source's floor/ceil
  // still converge toward 0 given enough time, but mic self-noise and a
  // slowly-decaying ceiling (adaptCeilFall) can otherwise nudge the
  // envelope a few % above zero even with nothing playing. Threshold is
  // set well above that noise so orbs only run when a source has real
  // signal.
  const CABLE_FLOW_LIVE_THRESHOLD = 0.08;
  // Envelope crossing above/below the threshold sample-to-sample (normal
  // signal jitter, brief dropouts between transients, normalization noise)
  // was flickering the orbs on/off within the same second. Debounce: go
  // live the instant a source crosses the threshold, but only go dark
  // after it's stayed below the threshold continuously for this long.
  const CABLE_FLOW_SILENCE_HOLD_MS = 500;
  const sourceLastLiveAt = { bass: -Infinity, mid: -Infinity, treble: -Infinity, volume: -Infinity };

  // B1: orbs are a binary "is this source making sound" indicator, not a
  // level meter (that's A2/A5's job) — every live cable runs its full
  // 4-orb pool at the same fixed speed (--lf-cable-duration, set in CSS),
  // a silent cable runs none. Orbs ride a shared CSS motion-path
  // (offset-path, set once in renderCable) with staggered animation-delay
  // for even spacing.
  //
  // .is-live toggles on the *orb group*, not the individual orbs: toggling
  // animation-play-state directly on each orb left them visible whenever
  // paused mid-lap, since pausing freezes the keyframe's current opacity
  // (which is 1 for most of the lap) instead of resetting to invisible.
  // The group's opacity is the actual visibility switch (CSS transition,
  // so it fades rather than snapping) and multiplies over whatever the
  // orb's own per-lap opacity happens to be, so a paused orb is always
  // fully hidden regardless of where it froze.
  function updateCableFlow() {
    // C4: cables represent signal actually reaching a target, not just the
    // source having sound (that's what the A2/A5 meters are for) — muted
    // means nothing reaches any target, so every cable goes dark
    // regardless of source activity. This is what "[ MUTE CABLES ]" means
    // literally, and it's the visual half of "targets hold their base
    // values" (computeTargetDeltas short-circuits the same way).
    if (audioPatch.global.muted) {
      for (const conn of audioPatch.connections) {
        cableFlowRefs[conn.id]?.group?.classList.remove('is-live');
      }
      return;
    }
    const now = performance.now();
    const sourceLive = {};
    for (const id of SOURCE_IDS) {
      if (sourceEnvelopes[id] >= CABLE_FLOW_LIVE_THRESHOLD) sourceLastLiveAt[id] = now;
      sourceLive[id] = now - sourceLastLiveAt[id] < CABLE_FLOW_SILENCE_HOLD_MS;
    }
    for (const conn of audioPatch.connections) {
      const refs = cableFlowRefs[conn.id];
      if (!refs || !refs.group) continue;
      refs.group.classList.toggle('is-live', sourceLive[conn.source]);
    }
  }

  let dragFromPort = null; // { kind: 'source'|'target', id }
  let dragLineEl = null;

  function updateDragLine(e) {
    if (!dragFromPort || !dragLineEl) return;
    const container = dragFromPort.kind === 'source' ? audioPatchSourcesEl : audioPatchTargetsEl;
    const portEl = container.querySelector(`[data-port="${dragFromPort.kind}"][data-id="${dragFromPort.id}"]`);
    const anchor = portCenter(portEl);
    const svgRect = audioPatchSvg.getBoundingClientRect();
    const pointer = { x: e.clientX - svgRect.left, y: e.clientY - svgRect.top };
    const d =
      dragFromPort.kind === 'source' ? cablePath(anchor, pointer) : cablePath(pointer, anchor);
    dragLineEl.setAttribute('d', d);
  }

  function endPortDrag(e) {
    window.removeEventListener('pointermove', updateDragLine);
    window.removeEventListener('pointerup', endPortDrag);
    if (dragLineEl) {
      dragLineEl.remove();
      dragLineEl = null;
    }
    if (!dragFromPort) return;

    const dropEl = document.elementFromPoint(e.clientX, e.clientY);
    const dropPort = dropEl && dropEl.closest('[data-port]');
    if (dropPort) {
      const dropKind = dropPort.dataset.port;
      const dropId = dropPort.dataset.id;
      if (dragFromPort.kind === 'source' && dropKind === 'target') {
        addConnection(dragFromPort.id, dropId);
      } else if (dragFromPort.kind === 'target' && dropKind === 'source') {
        addConnection(dropId, dragFromPort.id);
      }
    }
    dragFromPort = null;
  }

  function startPortDrag(e, kind, id) {
    e.preventDefault();
    dragFromPort = { kind, id };
    dragLineEl = document.createElementNS(SVG_NS, 'path');
    dragLineEl.setAttribute('class', 'lf-drag-line');
    audioPatchSvg.appendChild(dragLineEl);
    updateDragLine(e);
    window.addEventListener('pointermove', updateDragLine);
    window.addEventListener('pointerup', endPortDrag);
  }

  function buildConnectionsList() {
    audioPatchConnectionsEl.innerHTML = '';
    for (const conn of audioPatch.connections) {
      const row = document.createElement('div');
      row.className = 'lf-connrow lf-groove';
      row.innerHTML = `
        <span class="lf-cname">${SOURCE_LABELS[conn.source]} <span class="lf-arrow">&rarr;</span> ${TARGET_LABELS[conn.target]}</span>
        <input type="number" step="0.001" value="${conn.gain}" aria-label="gain" />
        <button type="button" class="lf-remove" aria-label="remove">&times;</button>
      `;
      const gainInput = row.querySelector('input');
      gainInput.addEventListener('change', (e) => {
        const value = parseFloat(e.target.value);
        if (!Number.isNaN(value)) {
          conn.gain = value;
          saveAudioPatch();
        }
      });
      row.querySelector('button').addEventListener('click', () => removeConnection(conn.id));
      audioPatchConnectionsEl.appendChild(row);
      attachNumberKnob(gainInput);
    }
  }

  function buildGlobalControls() {
    audioPatchGlobalEl.innerHTML = `
      <div class="lf-g"><div class="lf-fname">FLOOR RISE</div><input type="number" min="0" max="1" step="0.001" id="ap-global-floor-rise" value="${audioPatch.global.adaptFloorRise}" /></div>
      <div class="lf-g"><div class="lf-fname">CEIL FALL</div><input type="number" min="0" max="1" step="0.001" id="ap-global-ceil-fall" value="${audioPatch.global.adaptCeilFall}" /></div>
      <div class="lf-g"><div class="lf-fname">RADIUS DEBOUNCE MS</div><input type="number" min="0" step="10" id="ap-global-radius-debounce" value="${audioPatch.global.radiusDebounceMs}" /></div>
      <div class="lf-g"><div class="lf-fname">DEPTH %</div><input type="number" min="0" max="100" step="1" id="ap-global-depth" value="${audioPatch.global.depth}" /></div>
    `;
    const bind = (id, field) => {
      document.getElementById(id).addEventListener('change', (e) => {
        const value = parseFloat(e.target.value);
        if (!Number.isNaN(value)) {
          audioPatch.global[field] = value;
          saveAudioPatch();
        }
      });
    };
    bind('ap-global-floor-rise', 'adaptFloorRise');
    bind('ap-global-ceil-fall', 'adaptCeilFall');
    bind('ap-global-radius-debounce', 'radiusDebounceMs');
    bind('ap-global-depth', 'depth');
    audioPatchGlobalEl.querySelectorAll('input[type="number"]').forEach(attachNumberKnob);
  }

  // Cached per-source/target element refs, rebuilt each buildAudioPatchUI()
  // call — avoids the 4+5 querySelector calls updateAudioPatchMeters would
  // otherwise do every tick it runs (perf brainstorm doc, A2).
  const meterRefs = {};
  const targetValueRefs = {};
  // A1: lo/hi number inputs, so dragging a spectrum handle can push the
  // resulting Hz value back into the visible field without a per-drag-move
  // querySelector.
  const bandInputRefs = {};
  // B2: per-source history-lane canvas + 2D context.
  const historyRefs = {};

  function buildAudioPatchUI() {
    audioPatchSourcesEl.innerHTML = '';
    audioPatchTargetsEl.innerHTML = '';

    for (const id of SOURCE_IDS) {
      const band = audioPatch.bands[id];
      const node = document.createElement('div');
      node.className = 'lf-node';
      // Drives .lf-meter-fill's background (style.css) — matches this
      // source's color on the A1 spectrum strip and the A5 mini meter.
      node.style.setProperty('--lf-source-color', SOURCE_COLORS[id]);
      node.innerHTML = `
        <span class="lf-nname">${SOURCE_LABELS[id]}</span>
        <span class="lf-nval" data-meter="${id}">0.000</span>
        <div class="lf-meter" data-meter-bar="${id}">
          <div class="lf-meter-fill" data-meter-fill="${id}"></div>
          <div class="lf-meter-floor" data-meter-floor="${id}"></div>
          <div class="lf-meter-ceil" data-meter-ceil="${id}"></div>
          <div class="lf-meter-peak" data-meter-peak="${id}"></div>
          <div class="lf-meter-clip" data-meter-clip="${id}"></div>
        </div>
        <canvas class="lf-history" data-history="${id}" width="200" height="28"></canvas>
        <div class="lf-nmini">
          <input type="number" min="0" step="10" data-field="lo" value="${band.lo}" title="Lo Hz" />
          <input type="number" min="0" step="10" data-field="hi" value="${band.hi}" title="Hi Hz" />
          <input type="number" min="0" max="0.95" step="0.05" data-field="smoothing" value="${band.smoothing}" title="Smoothing" />
        </div>
        ${
          id === 'pitch'
            ? `<label class="lf-pitch-hold"><input type="checkbox" data-bool-field="hold" ${band.hold ? 'checked' : ''} /> HOLD</label>`
            : ''
        }
        <div class="lf-port" data-port="source" data-id="${id}"></div>
      `;
      node.querySelectorAll('input[data-field]').forEach((input) => {
        input.addEventListener('change', () => {
          const field = input.dataset.field;
          const value = parseFloat(input.value);
          if (Number.isNaN(value)) return;
          audioPatch.bands[id][field] = value;
          if (field === 'lo' || field === 'hi') {
            recomputeSourceBinRange(id);
            resetSourceRange(id);
          }
          saveAudioPatch();
        });
        attachNumberKnob(input);
      });
      const holdInput = node.querySelector('input[data-bool-field="hold"]');
      if (holdInput) {
        holdInput.addEventListener('change', () => {
          audioPatch.bands.pitch.hold = holdInput.checked;
          saveAudioPatch();
        });
      }
      audioPatchSourcesEl.appendChild(node);
      bandInputRefs[id] = {
        lo: node.querySelector('input[data-field="lo"]'),
        hi: node.querySelector('input[data-field="hi"]'),
      };
      meterRefs[id] = {
        value: node.querySelector(`[data-meter="${id}"]`),
        fill: node.querySelector(`[data-meter-fill="${id}"]`),
        floor: node.querySelector(`[data-meter-floor="${id}"]`),
        ceil: node.querySelector(`[data-meter-ceil="${id}"]`),
        peak: node.querySelector(`[data-meter-peak="${id}"]`),
        clip: node.querySelector(`[data-meter-clip="${id}"]`),
      };
      meterPeak[id] = 0;
      meterPeakAt[id] = 0;
      meterClipUntil[id] = 0;
      const historyCanvas = node.querySelector(`[data-history="${id}"]`);
      historyRefs[id] = { canvas: historyCanvas, ctx: historyCanvas.getContext('2d') };
    }

    for (const id of TARGET_IDS) {
      const node = document.createElement('div');
      node.className = 'lf-node';
      node.innerHTML = `
        <div class="lf-port" data-port="target" data-id="${id}"></div>
        <span class="lf-nname">${TARGET_LABELS[id]}</span>
        <span class="lf-nval" data-value="${id}">-</span>
      `;
      audioPatchTargetsEl.appendChild(node);
      targetValueRefs[id] = node.querySelector(`[data-value="${id}"]`);
    }

    audioPatchSourcesEl.querySelectorAll('[data-port="source"]').forEach((portEl) => {
      portEl.addEventListener('pointerdown', (e) => startPortDrag(e, 'source', portEl.dataset.id));
    });
    audioPatchTargetsEl.querySelectorAll('[data-port="target"]').forEach((portEl) => {
      portEl.addEventListener('pointerdown', (e) => startPortDrag(e, 'target', portEl.dataset.id));
    });

    buildConnectionsList();
    buildGlobalControls();
    redrawCables();
  }

  // B2: append the current envelopes to the ring buffers, then advance the
  // shared write pointer once (not per-source — all 4 stay in lockstep).
  function writeSourceHistory() {
    for (const id of SOURCE_IDS) sourceHistory[id][historyWriteIndex] = sourceEnvelopes[id];
    historyWriteIndex = (historyWriteIndex + 1) % HISTORY_LENGTH;
  }

  // B2: one ≤300-point polyline per source, read out of its ring buffer
  // oldest-to-newest starting at the current write pointer so the trace
  // scrolls continuously instead of jumping at the wrap point.
  function drawSourceHistoryLanes() {
    for (const id of SOURCE_IDS) {
      const refs = historyRefs[id];
      if (!refs) continue;
      const { canvas, ctx } = refs;
      const w = canvas.width;
      const h = canvas.height;
      const buf = sourceHistory[id];
      const n = buf.length;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = SOURCE_COLORS[id];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = buf[(historyWriteIndex + i) % n];
        const x = (i / (n - 1)) * w;
        const y = h - v * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function updateAudioPatchMeters() {
    if (!audioPatchModal.classList.contains('open')) return;
    // B3: hold the last-drawn picture while frozen — meters, peak/clip
    // state, the spectrum, history lanes, and target readouts all stop
    // advancing, but the sim (and sourceEnvelopes driving it) keeps
    // running via the frame() loop above.
    if (audioPatchFrozen) return;

    drawSpectrum();
    writeSourceHistory();
    drawSourceHistoryLanes();

    const now = performance.now();
    for (const id of SOURCE_IDS) {
      const v = sourceEnvelopes[id];
      const refs = meterRefs[id];
      if (!refs) continue;

      // D1: pitch shows Hz + nearest note name instead of the bare 0..1
      // envelope — "0.623" says nothing about a melody, "329Hz E4" does.
      refs.value.textContent =
        id === 'pitch' ? `${currentPitchHz > 0 ? Math.round(currentPitchHz) : '--'}Hz ${hzToNoteName(currentPitchHz)}` : v.toFixed(3);
      refs.fill.style.transform = `scaleX(${v})`;

      const range = sourceRanges[id];
      const span = range.ceil - range.floor;
      if (span > 1e-4) {
        refs.floor.style.left = `${Math.max(0, Math.min(1, range.floor)) * 100}%`;
        refs.ceil.style.left = `${Math.max(0, Math.min(1, range.ceil)) * 100}%`;
      }

      // Peak-hold: snap up instantly, hold, then decay back down — never
      // decays below the live value, so it can't visually lag a rising signal.
      if (v >= meterPeak[id]) {
        meterPeak[id] = v;
        meterPeakAt[id] = now;
      } else if (now - meterPeakAt[id] > METER_PEAK_HOLD_MS) {
        meterPeak[id] = Math.max(v, meterPeak[id] * METER_PEAK_DECAY);
      }
      refs.peak.style.left = `${meterPeak[id] * 100}%`;

      // Clip LED: envelope saturating at 1.0 means this band's adaptive
      // ceiling just re-locked to a new peak — held briefly so a single-tick
      // saturation is still visible at the modal's update rate.
      if (v >= METER_CLIP_THRESHOLD) meterClipUntil[id] = now + METER_CLIP_HOLD_MS;
      refs.clip.classList.toggle('is-clip', now < meterClipUntil[id]);
    }

    updateCableFlow();

    const deltas = computeTargetDeltas();
    const baseDt = parseFloat(document.getElementById('dt').value);
    const display = {
      mu: (currentMu + deltas.mu).toFixed(3),
      sigma: (currentSigma + deltas.sigma).toFixed(4),
      aberration: (1 + deltas.aberration).toFixed(2),
      radius: Math.round(parseInt(document.getElementById('radius').value, 10) + deltas.radius),
      dt: Math.min(DT_EFFECTIVE_MAX, Math.max(DT_EFFECTIVE_MIN, baseDt + deltas.dt)).toFixed(3),
    };
    for (const id of TARGET_IDS) {
      const el = targetValueRefs[id];
      if (el) el.textContent = String(display[id]);
    }
  }

  // A5: always-on mini meter row in the "09.audio reactive" control row —
  // the only Group A view visible during normal sim use (not gated on the
  // patch modal being open), so it stays as cheap as possible: 4 cached
  // element refs, one compositor-only scaleY transform write each.
  const miniMeterRefs = {};
  for (const id of SOURCE_IDS) {
    const bar = document.querySelector(`#audio-mini-meter [data-mini-bar="${id}"] .lf-mini-fill`);
    if (bar) {
      miniMeterRefs[id] = bar;
      // Driven from the same SOURCE_COLORS constant the A2 meters use
      // (via --lf-source-color) instead of a hand-duplicated CSS hex per
      // source — this markup is static so it can't use the custom-
      // property trick directly, but setting it once here still means
      // there's exactly one place a source's color is ever written down.
      bar.style.background = SOURCE_COLORS[id];
    }
  }

  function updateMiniMeter() {
    for (const id of SOURCE_IDS) {
      const el = miniMeterRefs[id];
      if (el) el.style.transform = `scaleY(${sourceEnvelopes[id]})`;
    }
  }

  document.getElementById('audio-patch-open').addEventListener('click', () => {
    audioPatchModal.classList.add('open');
    redrawCables();
    // The modal opens via a CSS transform/opacity transition (~150ms).
    // Cable endpoints are computed from getBoundingClientRect() on the
    // port elements, which reflects the modal's transform mid-animation
    // — redrawing immediately captures a still-scaled-down layout and
    // leaves a visible gap until something else triggers a redraw later.
    // Redraw again once the transition actually finishes.
    audioPatchModal.addEventListener(
      'transitionend',
      (e) => {
        if (e.target === audioPatchModal) redrawCables();
      },
      { once: true },
    );
  });
  document.getElementById('audio-patch-close').addEventListener('click', () => {
    audioPatchModal.classList.remove('open');
  });
  const audioPatchFreezeBtn = document.getElementById('audio-patch-freeze');
  audioPatchFreezeBtn.addEventListener('click', () => {
    audioPatchFrozen = !audioPatchFrozen;
    audioPatchFreezeBtn.classList.toggle('is-frozen', audioPatchFrozen);
  });

  // C4: panic mute — button in the modal header, plus a global keyboard
  // shortcut (see the 'm' case in the keydown handler below) so it's a
  // genuine one-click recovery even without the modal open. Cable flow
  // (updateCableFlow) and computeTargetDeltas both already short-circuit
  // on audioPatch.global.muted; this just flips that flag and syncs the
  // button's visual state.
  const audioPatchMuteBtn = document.getElementById('audio-patch-mute');
  function toggleAudioPatchMute() {
    audioPatch.global.muted = !audioPatch.global.muted;
    audioPatchMuteBtn.classList.toggle('is-muted', audioPatch.global.muted);
    saveAudioPatch();
  }
  audioPatchMuteBtn.classList.toggle('is-muted', audioPatch.global.muted);
  audioPatchMuteBtn.addEventListener('click', toggleAudioPatchMute);
  window.addEventListener('resize', () => {
    if (audioPatchModal.classList.contains('open')) redrawCables();
  });

  buildAudioPatchUI();

  {
    // Browsers restore form control state (including checkbox .checked)
    // across a same-tab reload independent of any app state — no change
    // event fires for that restoration, so audioReactiveEnabled stays
    // false while the checkbox visually shows checked, and mic access was
    // never actually re-requested this session. Force it unchecked on
    // every load so the checkbox always reflects real state and a click
    // is what it takes to (re-)request the mic, not two.
    const checkbox = document.getElementById('audio-reactive-enabled');
    checkbox.checked = false;
    syncCheckActive(checkbox);
  }

  document.getElementById('audio-reactive-enabled').addEventListener('change', async (e) => {
    const checkbox = e.target;
    if (checkbox.checked) {
      try {
        await enableAudioReactive();
        document.getElementById('error').textContent = '';
      } catch (err) {
        checkbox.checked = false;
        document.getElementById('error').textContent = `Failed to enable audio-reactive mode: ${err}`;
      }
    } else {
      disableAudioReactive();
    }
    syncCheckActive(checkbox);
  });

  function applyKernel() {
    const radius = parseInt(document.getElementById('radius').value, 10);
    const core = parseInt(document.getElementById('kernel-core').value, 10);
    app.setKernel(radius, core, currentBeta());
    // Landscape heatmap is a precomputed-matrix fetch (see
    // loadLandscapeForCurrentKernel), not a live recompute — cheap enough
    // to just do on every kernel change, unlike the from-scratch
    // simulation approach this replaced (300 scratch simulations, each up
    // to 150 steps on a grid as large as 96x96, which visibly stuttered
    // the running simulation and is why it was disabled entirely before).
    scheduleLandscapeReload();
  }

  // Keeps a range slider and a typed number input showing the same value,
  // in either direction, so exact values (e.g. for reproducible perf
  // captures) can be typed instead of only dragged. `onChange` reads back
  // from the range element itself (kept in sync here), matching how
  // applyParams/applyKernel/brushRadius already read their inputs.
  // Delays `fn` until `ms` have passed with no further calls, so a rapidly
  // firing event stream (e.g. dragging a slider) collapses to one trailing
  // call instead of one per event.
  function debounce(fn, ms) {
    let handle = null;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  }

  function linkRangeAndNumber(rangeId, numberId, onChange) {
    const rangeEl = document.getElementById(rangeId);
    const numberEl = document.getElementById(numberId);
    const sync = (value) => {
      rangeEl.value = value;
      numberEl.value = value;
      onChange();
    };
    rangeEl.addEventListener('input', () => sync(rangeEl.value));
    numberEl.addEventListener('input', () => {
      if (numberEl.value === '') return;
      sync(numberEl.value);
    });
  }

  linkRangeAndNumber('dt', 'dt-input', applyParams);
  // Dragging this slider fires an 'input' event per pixel of movement, and
  // each one currently triggers a full kernel rebuild + full-grid kernel
  // FFT (~one step's worth of cost) synchronously on the main thread —
  // debounced so only the trailing value after a drag/keystroke pause
  // rebuilds, instead of every intermediate radius (docs/perf/audit-2026-08-28.md item 9).
  linkRangeAndNumber('radius', 'radius-input', debounce(applyKernel, 120));
  linkRangeAndNumber('brush-radius', 'brush-radius-input', updateCachedBrushRadius);

  // Static number inputs in the Lenia field menu (mu/sigma + the three
  // range-paired ones above) — the audio patch modal's number inputs are
  // rebuilt dynamically, so they're wrapped at their own creation sites
  // instead (buildAudioPatchUI/buildConnectionsList/buildGlobalControls).
  document.querySelectorAll('#controls input[type="number"]').forEach(attachNumberKnob);

  document.getElementById('growth-fn').addEventListener('input', applyParams);
  // Separate listener (not folded into applyParams) since applyParams also
  // runs on every mu/sigma drag and audio-reactive tick, neither of which
  // should reload the landscape — only an actual growth-fn change should.
  document.getElementById('growth-fn').addEventListener('input', scheduleLandscapeReload);

  // Toggles the lf- design system's prism text-shadow on a .lf-check row
  // (dither/audio-reactive) to match its checkbox's current state — see
  // DESIGN_SPEC.md's class mapping table.
  function syncCheckActive(checkboxEl) {
    checkboxEl.closest('.lf-check')?.classList.toggle('is-active', checkboxEl.checked);
  }

  function applyDither() {
    const ditherCheckbox = document.getElementById('dither-enabled');
    const levels = parseFloat(document.getElementById('dither-levels').value);
    const enabled = ditherCheckbox.checked;
    app.setDither(levels, enabled);
    syncCheckActive(ditherCheckbox);
  }

  // No paired number input for dither levels (consolidated into one
  // checkbox+slider row, see index.html) — just listen on the slider.
  document.getElementById('dither-levels').addEventListener('input', applyDither);
  document.getElementById('dither-enabled').addEventListener('change', applyDither);

  function setMuSigmaFromInputs() {
    const mu = Math.max(0, Math.min(MU_MAX, parseFloat(muInput.value)));
    const sigma = Math.max(0, Math.min(SIGMA_MAX, parseFloat(sigmaInput.value)));
    if (Number.isNaN(mu) || Number.isNaN(sigma)) return;
    currentMu = mu;
    currentSigma = sigma;
    updateReadout();
    drawMap();
    applyParams();
  }

  muInput.addEventListener('input', setMuSigmaFromInputs);
  sigmaInput.addEventListener('input', setMuSigmaFromInputs);
  document.getElementById('kernel-core').addEventListener('input', applyKernel);

  // Presets: capture/restore full sim state (params + kernel + dither +
  // live grid) so a session can be saved and resumed exactly, unlike
  // patterns (which only seed mu/sigma/grid, not dt/dither/etc).
  const PRESETS_KEY = 'lenia-presets';
  const presetSelect = document.getElementById('preset-select');
  const presetNameInput = document.getElementById('preset-name');

  function loadPresetStore() {
    try {
      return JSON.parse(localStorage.getItem(PRESETS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePresetStore(store) {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(store));
  }

  // D3: summarizes a preset's saved audio patch (band ranges + connection
  // count) for the <option>'s title tooltip — old presets have no
  // audioPatch field, so this just returns '' and the option gets no
  // tooltip at all.
  function summarizeAudioPatch(patch) {
    if (!patch || !patch.bands || !patch.connections) return '';
    const bands = SOURCE_IDS.map((id) => `${id} ${patch.bands[id].lo}-${patch.bands[id].hi}Hz`).join(', ');
    const count = patch.connections.length;
    return `${count} cable${count === 1 ? '' : 's'} — ${bands}`;
  }

  function refreshPresetSelect(selectName) {
    const store = loadPresetStore();
    const names = Object.keys(store).sort();
    presetSelect.innerHTML = '<option value="">-- choose --</option>';
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      const summary = summarizeAudioPatch(store[name].audioPatch);
      if (summary) opt.title = summary;
      presetSelect.appendChild(opt);
    }
    if (selectName && names.includes(selectName)) presetSelect.value = selectName;
  }

  // Grid cells are quantized to 8-bit (the same precision the renderer
  // already quantizes to for display, so no visible loss) then gzipped via
  // the browser's native CompressionStream before base64 encoding. Plain
  // JSON floats for a full grid run ~250KB; this typically gets it under
  // 20KB since Lenia fields are smooth (large compressible runs).
  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function encodeGridToken(floats) {
    const quantized = new Uint8Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      quantized[i] = Math.max(0, Math.min(255, Math.round(floats[i] * 255)));
    }
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(quantized);
    writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return bytesToBase64(compressed);
  }

  async function decodeGridToken(token, length) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(base64ToBytes(token));
    writer.close();
    const quantized = new Uint8Array(await new Response(ds.readable).arrayBuffer());
    const floats = new Float32Array(length);
    for (let i = 0; i < length; i++) floats[i] = quantized[i] / 255;
    return floats;
  }

  async function buildPresetObject() {
    return {
      mu: currentMu,
      sigma: currentSigma,
      dt: parseFloat(document.getElementById('dt').value),
      radius: parseInt(document.getElementById('radius').value, 10),
      kernelCore: parseInt(document.getElementById('kernel-core').value, 10),
      growthFn: parseInt(document.getElementById('growth-fn').value, 10),
      beta: activeBeta,
      ditherLevels: parseFloat(document.getElementById('dither-levels').value),
      ditherEnabled: document.getElementById('dither-enabled').checked,
      gridWidth,
      gridHeight,
      gridToken: await encodeGridToken(app.stateSnapshot()),
      // D3 (audio-visualization-brainstorm.md): captures bands,
      // connections, and global settings (including C4's depth/muted) —
      // deep-cloned so later edits to the live audioPatch can't leak back
      // into a saved preset object.
      audioPatch: JSON.parse(JSON.stringify(audioPatch)),
    };
  }

  // D3: repopulates the live audioPatch object's own properties in place
  // (it's a const captured by closures all over the audio-reactive code —
  // reassigning it isn't an option) rather than replacing it outright.
  // Missing sub-fields (an older preset, or one saved before some field
  // existed) fall back to defaultAudioPatch()'s values, same merge
  // defaultAudioPatch()'s own loadAudioPatch() already does for
  // localStorage.
  function restoreAudioPatch(saved) {
    if (!saved) return; // old presets predate D3 — leave the current patch untouched
    const defaults = defaultAudioPatch();
    audioPatch.bands = { ...defaults.bands, ...saved.bands };
    audioPatch.connections = Array.isArray(saved.connections) ? saved.connections : defaults.connections;
    audioPatch.global = { ...defaults.global, ...saved.global };
    for (const id of SOURCE_IDS) {
      recomputeSourceBinRange(id);
      resetSourceRange(id);
    }
    saveAudioPatch();
    buildAudioPatchUI(); // rebuilds nodes/cables/globals from the restored bands+connections
    audioPatchMuteBtn.classList.toggle('is-muted', audioPatch.global.muted);
  }

  async function applyPreset(preset) {
    currentMu = preset.mu;
    currentSigma = preset.sigma;
    activeBeta = preset.beta;

    document.getElementById('dt').value = preset.dt;
    document.getElementById('dt-input').value = preset.dt;
    document.getElementById('radius').value = preset.radius;
    document.getElementById('radius-input').value = preset.radius;
    document.getElementById('kernel-core').value = preset.kernelCore;
    document.getElementById('growth-fn').value = preset.growthFn;
    document.getElementById('dither-levels').value = preset.ditherLevels;
    document.getElementById('dither-enabled').checked = preset.ditherEnabled;

    applyKernel();
    applyParams();
    applyDither();
    restoreAudioPatch(preset.audioPatch);
    const floats = await decodeGridToken(preset.gridToken, preset.gridWidth * preset.gridHeight);
    app.loadGridSnapshot(preset.gridWidth, preset.gridHeight, floats);

    updateReadout();
    drawMap();
  }

  document.getElementById('preset-save').addEventListener('click', async () => {
    const name = presetNameInput.value.trim();
    if (!name) return;
    const store = loadPresetStore();
    store[name] = await buildPresetObject();
    savePresetStore(store);
    refreshPresetSelect(name);
    document.getElementById('error').textContent = '';
  });

  presetSelect.addEventListener('change', async () => {
    const name = presetSelect.value;
    if (!name) return;
    const store = loadPresetStore();
    const preset = store[name];
    if (!preset) return;
    activePreset = preset;
    presetNameInput.value = name;
    await applyPreset(preset);
  });

  document.getElementById('preset-delete').addEventListener('click', () => {
    const name = presetSelect.value;
    if (!name) return;
    const store = loadPresetStore();
    delete store[name];
    savePresetStore(store);
    if (activePreset && presetNameInput.value === name) activePreset = null;
    refreshPresetSelect();
  });

  document.getElementById('preset-export').addEventListener('click', async () => {
    const name = presetSelect.value || presetNameInput.value.trim();
    if (!name) return;
    const store = loadPresetStore();
    const preset = store[name] || (await buildPresetObject());
    const blob = new Blob([JSON.stringify(preset)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.lenia-preset.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const presetImportFile = document.getElementById('preset-import-file');
  document.getElementById('preset-import-trigger').addEventListener('click', () => {
    presetImportFile.click();
  });
  presetImportFile.addEventListener('change', async () => {
    const file = presetImportFile.files[0];
    presetImportFile.value = '';
    if (!file) return;
    try {
      const preset = JSON.parse(await file.text());
      const name = file.name.replace(/\.lenia-preset\.json$/, '').replace(/\.json$/, '');
      const store = loadPresetStore();
      store[name] = preset;
      savePresetStore(store);
      refreshPresetSelect(name);
      activePreset = preset;
      presetNameInput.value = name;
      await applyPreset(preset);
      document.getElementById('error').textContent = '';
    } catch (err) {
      document.getElementById('error').textContent = `Failed to import preset: ${err}`;
    }
  });

  refreshPresetSelect();

  document.getElementById('pattern-select').addEventListener('change', async (e) => {
    const path = e.target.value;
    if (!path) return;
    try {
      await loadPattern(path);
      document.getElementById('error').textContent = '';
    } catch (err) {
      document.getElementById('error').textContent = `Failed to load pattern: ${err}`;
    }
  });

  // Brushing: paint activated cells with mouse or touch. Pointer Events
  // unify mouse/touch/pen into one API. Coordinates are mapped from the
  // canvas's CSS display box into grid-space using its current dimensions,
  // which stay valid across resizes since gridWidth/gridHeight are updated
  // in place by handleResize below.
  function toGridCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    return [(px / rect.width) * gridWidth, (py / rect.height) * gridHeight];
  }

  let painting = false;
  let lastGridPos = null; // [gx, gy], null when no stroke is in progress

  // Cached rather than re-parsed on every call — brushRadius() is called
  // once per paint() during a stroke and once per frame while held (see
  // frame()), so a fresh parseFloat/getElementById per call adds up during
  // a long stroke for no benefit, since the value only actually changes on
  // the brush-radius input's own 'input' event.
  let cachedBrushRadius = parseFloat(document.getElementById('brush-radius').value);
  function updateCachedBrushRadius() {
    cachedBrushRadius = parseFloat(document.getElementById('brush-radius').value);
  }
  function brushRadius() {
    return cachedBrushRadius;
  }

  // Paints from lastGridPos to (gx, gy), stepping along the path so fast
  // pointer movement doesn't leave gaps between brush circles (a single
  // paint call per pointermove event is too sparse during fast strokes).
  function paintStroke(gx, gy) {
    const radius = brushRadius();
    if (lastGridPos) {
      const [lx, ly] = lastGridPos;
      const dist = Math.hypot(gx - lx, gy - ly);
      const step = Math.max(1, radius / 2);
      const steps = Math.ceil(dist / step);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        app.paint(lx + (gx - lx) * t, ly + (gy - ly) * t, radius);
      }
    } else {
      app.paint(gx, gy, radius);
    }
    lastGridPos = [gx, gy];
  }

  canvas.addEventListener('pointerdown', (e) => {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    lastGridPos = null;
    const [gx, gy] = toGridCoords(e);
    paintStroke(gx, gy);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const [gx, gy] = toGridCoords(e);
    paintStroke(gx, gy);
  });
  canvas.addEventListener('pointerup', () => {
    painting = false;
    lastGridPos = null;
  });
  canvas.addEventListener('pointercancel', () => {
    painting = false;
    lastGridPos = null;
  });

  // Params menu: no intermediary button. "t" toggles it directly on
  // desktop; a double-tap toggles it on touch devices (same gesture space
  // users expect for "reveal hidden UI" on mobile).
  function toggleControls() {
    document.getElementById('controls').classList.toggle('open');
  }

  // Perf HUD: desktop-only benchmarking tool. Toggled via "p" only —
  // deliberately not wired to double-tap, since double-tap needs to stay
  // unambiguous for the params menu on touch devices, and the HUD is
  // force-hidden on touch anyway (see style.css).
  function togglePerfHud() {
    document.getElementById('perf-hud').classList.toggle('open');
  }

  function isInteractiveTarget(target) {
    return !!target.closest('input, select, textarea, button');
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isInteractiveTarget(document.activeElement)) return;
    const key = e.key.toLowerCase();
    if (key === 't') toggleControls();
    else if (key === 'p') togglePerfHud();
    else if (key === 'm') toggleAudioPatchMute();
  });

  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_DIST_PX = 40;
  let lastTapTime = 0;
  let lastTapPos = null;

  window.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || isInteractiveTarget(e.target)) return;
    const now = performance.now();
    const pos = [e.clientX, e.clientY];
    const isDoubleTap =
      lastTapPos !== null &&
      now - lastTapTime < DOUBLE_TAP_MS &&
      Math.hypot(pos[0] - lastTapPos[0], pos[1] - lastTapPos[1]) < DOUBLE_TAP_DIST_PX;
    if (isDoubleTap) {
      toggleControls();
      lastTapTime = 0;
      lastTapPos = null;
    } else {
      lastTapTime = now;
      lastTapPos = pos;
    }
  });

  document.getElementById('perf-capture').addEventListener('click', () => {
    capturing = true;
    captureFrames = [];
    captureUntil = performance.now() + 2000;
  });

  // Resizing rebuilds the simulation grid at the new aspect ratio (the FFT
  // plan is tied to grid dimensions, so this is a full re-init, not a
  // resample) and reloads the current pattern into the fresh grid. Debounced
  // so a continuous window-drag doesn't trigger a re-plan on every frame.
  async function handleResize() {
    const sized = computeGridSize();
    pixelW = sized.pixelW;
    pixelH = sized.pixelH;
    gridWidth = sized.gridWidth;
    gridHeight = sized.gridHeight;
    app.resize(pixelW, pixelH, gridWidth, gridHeight);
    try {
      if (activePreset) {
        await applyPreset(activePreset);
      } else {
        await loadPattern(currentPatternPath);
      }
      document.getElementById('error').textContent = '';
    } catch (err) {
      document.getElementById('error').textContent = `Failed to reload pattern after resize: ${err}`;
    }
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeDebounceHandle);
    resizeDebounceHandle = setTimeout(handleResize, 200);
  });

  updateReadout();
  drawMap();
  loadLandscapeForCurrentKernel();

  window.__leniaApp = app; // exposed for manual debugging
}

main().catch((err) => {
  console.error(err);
  document.getElementById('error').textContent = String(err);
});
