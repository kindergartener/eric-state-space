/*
  ui-render-helpers.js
  Two pure rendering helpers wired into the app's draw calls (see main.js):

    1. renderLandscape(ctx, w, h, hoverX, hoverY)
       Draws the mu/sigma "landscape" screen inside #controls .lf-heat canvas.
       Composited on top of the existing data-driven heatmap via a 'screen'
       blend, as a lighting pass rather than a replacement.

    2. renderCable(svgNS, x1, y1, x2, y2, opts)
       Returns a <g> element containing a crisp white core path plus 2 blurred
       colored duplicate paths (the prism-fringe trick), for one connection
       in the audio patch matrix.

  Vendored from docs/design/ui-render-helpers.js and converted to an ES
  module (the original ships as a plain/CommonJS script) so main.js — a
  <script type="module"> — can import it directly. Also adds
  resetCableColorCycle(), not present in the original: main.js redraws all
  cables from scratch on every connection add/remove/drag, and without a
  reset the color-cycle index would keep incrementing across redraws
  instead of starting fresh each time (see DESIGN_SPEC.md open question 2).
*/

// ---------- 1. landscape screen ----------

/**
 * Paints the black/white/prism landscape glow onto a 2D canvas context.
 * Call this AFTER any existing mu/sigma data heatmap has been drawn, using
 * 'screen' composite mode so the fringe adds light rather than replacing data.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w - canvas width in px
 * @param {number} h - canvas height in px
 * @param {number} hoverX - 0..1, current mu/sigma marker x position
 * @param {number} hoverY - 0..1, current mu/sigma marker y position
 */
export function renderLandscape(ctx, w, h, hoverX, hoverY) {
  const cx = hoverX * w;
  const cy = hoverY * h;

  // soft white core
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  let core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.35);
  core.addColorStop(0, 'rgba(255,255,255,0.9)');
  core.addColorStop(0.55, 'rgba(255,255,255,0.15)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, w, h);

  // prism fringe — 4 offset color blooms around the core, low opacity, blurred
  const fringes = [
    { dx: -0.08, dy: 0.00, color: 'rgba(255,70,70,0.55)' },  // red
    { dx: 0.08, dy: 0.08, color: 'rgba(90,255,140,0.5)' },   // green
    { dx: 0.00, dy: -0.06, color: 'rgba(80,210,255,0.5)' },  // cyan
    { dx: -0.04, dy: 0.12, color: 'rgba(190,110,255,0.4)' }, // violet
  ];
  ctx.filter = 'blur(6px)';
  for (const f of fringes) {
    const fx = cx + f.dx * w;
    const fy = cy + f.dy * h;
    let g = ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.min(w, h) * 0.3);
    g.addColorStop(0, f.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.filter = 'none';
  ctx.restore();
}

// ---------- 2. patch-bay cable ----------

const CABLE_COLORS = ['#ff4646', '#5affa0', '#46d1ff', '#c07bff'];
let _cableColorIdx = 0;

/**
 * Resets the per-cable color cycle. Call once at the start of a full
 * redraw (not per cable, and not per animation frame) so repeated
 * redraws produce the same color sequence instead of drifting.
 */
export function resetCableColorCycle() {
  _cableColorIdx = 0;
}

/**
 * Builds one prism-fringed cable as an SVG <g>.
 * @param {string} svgNS - typically 'http://www.w3.org/2000/svg'
 * @param {number} x1 @param {number} y1 - source port position
 * @param {number} x2 @param {number} y2 - target port position
 * @param {{filterId?: string, coreOpacity?: number}} [opts]
 * @returns {SVGGElement}
 */
export function renderCable(svgNS, x1, y1, x2, y2, opts = {}) {
  const filterId = opts.filterId || 'lf-cable-blur';
  const coreOpacity = opts.coreOpacity ?? 0.8;
  const midX = (x1 + x2) / 2;

  const g = document.createElementNS(svgNS, 'g');

  // two nearby prism colors, cycled per cable so adjacent connections
  // don't all fringe identically
  const cA = CABLE_COLORS[_cableColorIdx % CABLE_COLORS.length];
  const cB = CABLE_COLORS[(_cableColorIdx + 1) % CABLE_COLORS.length];
  _cableColorIdx++;

  const blurred = document.createElementNS(svgNS, 'g');
  blurred.setAttribute('filter', `url(#${filterId})`);
  blurred.setAttribute('opacity', '0.55');

  const d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;

  for (const [color, offset] of [[cA, -1], [cB, 1]]) {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', `M${x1},${y1 + offset} C${midX},${y1 + offset} ${midX},${y2 + offset} ${x2},${y2 + offset}`);
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '2');
    p.setAttribute('fill', 'none');
    blurred.appendChild(p);
  }
  g.appendChild(blurred);

  const core = document.createElementNS(svgNS, 'path');
  core.setAttribute('d', d);
  core.setAttribute('stroke', '#f2f2f2');
  core.setAttribute('stroke-width', '1.2');
  core.setAttribute('fill', 'none');
  core.setAttribute('opacity', String(coreOpacity));
  core.setAttribute('class', 'lf-cable-core');
  g.appendChild(core);

  // Signal flow (B1, audio-visualization-brainstorm.md): a small pool of
  // glowing orbs riding this cable's own curve via CSS motion-path
  // (offset-path/offset-distance), most idle at rest. main.js toggles how
  // many are active (density) and their shared speed off the connection's
  // source envelope — see updateCableFlow(). Built here rather than from
  // the `d` string alone so they inherit the cable's own two fringe
  // colors, matching its identity in the graph.
  const ORB_COUNT = 4;
  const orbGroup = document.createElementNS(svgNS, 'g');
  orbGroup.setAttribute('class', 'lf-cable-orbs');
  orbGroup.setAttribute('filter', `url(#${filterId})`);
  for (let i = 0; i < ORB_COUNT; i++) {
    const orb = document.createElementNS(svgNS, 'circle');
    orb.setAttribute('r', '2.2');
    orb.setAttribute('fill', i % 2 === 0 ? cA : cB);
    orb.setAttribute('class', 'lf-cable-orb');
    orb.style.offsetPath = `path('${d}')`;
    orbGroup.appendChild(orb);
  }
  g.appendChild(orbGroup);

  return g;
}

/**
 * Call once when the patch modal mounts: injects the shared blur filter
 * that renderCable() references via #lf-cable-blur.
 */
export function ensureCableFilter(svgEl, svgNS, filterId = 'lf-cable-blur') {
  if (svgEl.querySelector(`#${filterId}`)) return;
  const defs = document.createElementNS(svgNS, 'defs');
  const filter = document.createElementNS(svgNS, 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('x', '-20%'); filter.setAttribute('y', '-20%');
  filter.setAttribute('width', '140%'); filter.setAttribute('height', '140%');
  const blur = document.createElementNS(svgNS, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '1.6');
  filter.appendChild(blur);
  defs.appendChild(filter);
  svgEl.prepend(defs);
}
