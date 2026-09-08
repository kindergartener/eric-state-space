/* tslint:disable */
/* eslint-disable */

export class LeniaApp {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `[min_x, min_y, max_x, max_y]` (inclusive) of cells with `state >
     * eps`, or an empty array if every cell is `<= eps`. Exposed for
     * empirical `eps` tuning ahead of tier 3 item 1 (windowed
     * convolution) — not yet used by the render/step path itself. See
     * docs/perf/tier3-spec.md section 2b.
     */
    activeBoundingBox(eps: number): Uint32Array;
    attachCanvas(canvas: HTMLCanvasElement): Promise<void>;
    /**
     * `[x0, y0, width, height]` of the window `stepDecideWindow()` most
     * recently selected, or an empty array if the most recent decision
     * was full-grid (either reason). For the HUD to display what
     * `step()` is actually doing.
     */
    currentWindowInfo(): Uint32Array;
    /**
     * Most recently completed GPU render-pass duration in milliseconds,
     * or NaN if unavailable (no renderer attached yet, or the adapter
     * doesn't support TIMESTAMP_QUERY).
     */
    lastGpuTimeMs(): number;
    /**
     * Loads a raw grid snapshot (e.g. from a saved preset) into the sim,
     * centering it if its dimensions differ from the current grid — same
     * centering behavior as `loadPattern`. Does not touch kernel/growth
     * params; callers should also call `setParams`/`setKernel` to restore
     * those from the preset.
     */
    loadGridSnapshot(width: number, height: number, cells: Float32Array): void;
    loadPattern(json: string): void;
    constructor(width: number, height: number);
    /**
     * Paints a soft-edged circular brush at grid-space (x, y) with the
     * given radius (in grid cells). Blends via max() into existing state.
     */
    paint(x: number, y: number, radius: number): void;
    render(): void;
    /**
     * Rebuilds the simulation grid at a new resolution and resizes the
     * render surface to match. This resets the simulation state (the FFT
     * plan is tied to grid dimensions, so a resize is a full re-init, not
     * a resample) — callers should reload a pattern afterward if they want
     * a populated grid rather than a blank one.
     */
    resize(canvas_width: number, canvas_height: number, grid_width: number, grid_height: number): void;
    /**
     * Audio-reactive multiplier on the base chromatic-aberration
     * sensitivity; 1.0 is baseline/unchanged.
     */
    setAberrationMult(mult: number): void;
    /**
     * levels: number of quantization steps per color channel (>= 2).
     */
    setDither(levels: number, enabled: boolean): void;
    setKernel(radius: number, core: number, beta: Float32Array): void;
    /**
     * core: 0 = exponential, 1 = polynomial, 2 = rectangular
     * growth: 0 = exponential, 1 = polynomial, 2 = rectangular
     */
    setParams(mu: number, sigma: number, dt: number, growth: number): void;
    /**
     * Returns a copy of the current state grid (row-major, width*height).
     */
    stateSnapshot(): Float32Array;
    step(): void;
    /**
     * Decides windowed-vs-full-grid for this step, exactly as `step()`
     * itself would — call this first, then call either the
     * `stepWindowed*` sequence (if this returns `2`) or the plain
     * `step*` sequence below (for `0` or `1`), so the JS side can
     * bracket each stage with `performance.now()` for the HUD's stage
     * breakdown while still running the identical decision/math `step()`
     * would have. Not called on the default (HUD-closed, not capturing)
     * path — see main.js's `frame()` — so `step()` pays none of this
     * overhead. Return value: `0` = full-grid (scan ran, no window
     * found), `1` = full-grid (negative cache skipped the scan), `2` =
     * windowed — see `sim::StepMode`.
     */
    stepDecideWindow(): number;
    /**
     * Full-grid split-phase stage, called after `stepDecideWindow()`
     * returned `0` or `1`.
     */
    stepFftForward(): void;
    stepFftInverse(): void;
    stepIntegrate(): void;
    stepMultiply(): void;
    /**
     * Windowed split-phase stage, called after `stepDecideWindow()`
     * returned `2`.
     */
    stepWindowedFftForward(): void;
    stepWindowedFftInverse(): void;
    stepWindowedIntegrate(): void;
    stepWindowedMultiply(): void;
    /**
     * Whether windowed convolution would currently be unsafe (`g(0) >
     * 0`) — see `Simulation::vacuum_grows`'s doc comment.
     */
    vacuumGrows(): boolean;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_leniaapp_free: (a: number, b: number) => void;
    readonly leniaapp_activeBoundingBox: (a: number, b: number) => [number, number];
    readonly leniaapp_attachCanvas: (a: number, b: any) => any;
    readonly leniaapp_currentWindowInfo: (a: number) => [number, number];
    readonly leniaapp_lastGpuTimeMs: (a: number) => number;
    readonly leniaapp_loadGridSnapshot: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leniaapp_loadPattern: (a: number, b: number, c: number) => [number, number];
    readonly leniaapp_new: (a: number, b: number) => number;
    readonly leniaapp_paint: (a: number, b: number, c: number, d: number) => void;
    readonly leniaapp_render: (a: number) => void;
    readonly leniaapp_resize: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leniaapp_setAberrationMult: (a: number, b: number) => void;
    readonly leniaapp_setDither: (a: number, b: number, c: number) => void;
    readonly leniaapp_setKernel: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leniaapp_setParams: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly leniaapp_stateSnapshot: (a: number) => [number, number];
    readonly leniaapp_step: (a: number) => void;
    readonly leniaapp_stepDecideWindow: (a: number) => number;
    readonly leniaapp_stepFftForward: (a: number) => void;
    readonly leniaapp_stepFftInverse: (a: number) => void;
    readonly leniaapp_stepIntegrate: (a: number) => void;
    readonly leniaapp_stepMultiply: (a: number) => void;
    readonly leniaapp_stepWindowedFftForward: (a: number) => void;
    readonly leniaapp_stepWindowedFftInverse: (a: number) => void;
    readonly leniaapp_stepWindowedIntegrate: (a: number) => void;
    readonly leniaapp_stepWindowedMultiply: (a: number) => void;
    readonly leniaapp_vacuumGrows: (a: number) => number;
    readonly start: () => void;
    readonly wasm_bindgen__convert__closures_____invoke__h16bf16a8b3c427ec: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h1726459f4ab8f1fd: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf1cfcd1ab776522a: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hf1cfcd1ab776522a_2: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
