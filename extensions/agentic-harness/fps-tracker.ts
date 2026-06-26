/**
 * PI_FPS opt-in footer FPS measurement.
 *
 * WHAT THIS MEASURES (read before trusting the number):
 * The TUI paints a frame by walking its component tree and calling each
 * component's `render(width)`. `RoachFooter.render()` therefore executes once
 * per *actually painted* frame. The TUI coalesces/throttles paint requests, so
 * this counts real painted frames — NOT the raw number of `requestRender()`
 * calls (those can be far higher and are deduped by the render scheduler).
 *
 * Consequently, when the UI is idle (no animation, no streaming output, no
 * typing) the TUI stops painting and the measured FPS naturally drops toward 0.
 * That is the honest frame rate, not a bug. During spinner animation, streaming
 * output, or active typing the rate rises.
 *
 * Enable with `PI_FPS=1` (also accepts `true`/`yes`). Disabled by default → the
 * footer FPS segment is absent and `RoachFooter` never instantiates a tracker,
 * so there is zero overhead and no output change.
 */

/**
 * Parse the PI_FPS env flag. Mirrors the `isTruthyEnvFlag` convention used by
 * pi-core (`PI_STARTUP_BENCHMARK` etc.). Accepts "1"/"true"/"yes"
 * (case-insensitive); everything else (including unset) is disabled.
 */
export function isFpsEnabled(value: string | undefined = process.env.PI_FPS): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// EMA smoothing factor for the instantaneous FPS. Lower = smoother/slower to
// react; higher = snappier/noisier. 0.2 tracks ~last 5 frames.
const FPS_EMA_ALPHA = 0.2;
// Minimum interval (ms) between samples to count. Guards against sub-microsecond
// deltas (e.g. double render in the same tick) producing absurd FPS spikes.
const FPS_MIN_INTERVAL_MS = 0.5;
// If no frame has been painted for longer than this, report FPS 0 rather than a
// stale smoothed number — reflects that the TUI is genuinely idle.
const FPS_IDLE_MS = 1500;

export interface FpsLabel {
	/** Human-readable footer label, e.g. `FPS 42` or `FPS --`. */
	text: string;
}

/**
 * Tracks painted-frame rate via an exponential moving average of inter-frame
 * intervals. `now` is injectable so unit tests can drive deterministic time.
 */
export class FpsTracker {
	private lastAt: number | null = null;
	private ema: number | null = null;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	/**
	 * Record a painted frame. Returns the current smoothed FPS, or null until at
	 * least two frames have been observed.
	 */
	tick(): number | null {
		const at = this.now();
		if (this.lastAt !== null) {
			const dt = at - this.lastAt;
			if (dt > FPS_MIN_INTERVAL_MS) {
				const instant = 1000 / dt;
				this.ema =
					this.ema === null ? instant : this.ema * (1 - FPS_EMA_ALPHA) + instant * FPS_EMA_ALPHA;
			}
		}
		this.lastAt = at;
		return this.ema;
	}

	/** Smoothed FPS, or null if not enough samples yet. */
	current(): number | null {
		return this.ema;
	}

	/** Footer label reflecting current state, including idle decay. */
	display(): string {
		if (this.lastAt === null || this.ema === null) return "FPS --";
		const gap = this.now() - this.lastAt;
		if (gap > FPS_IDLE_MS) return "FPS 0";
		return `FPS ${Math.round(this.ema)}`;
	}
}
