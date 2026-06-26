import { describe, expect, it } from "vitest";
import { FpsTracker, isFpsEnabled } from "../fps-tracker.js";

describe("isFpsEnabled", () => {
	const orig = process.env.PI_FPS;
	const cases: Array<[string | undefined, boolean]> = [
		["1", true],
		["true", true],
		["TRUE", true],
		["yes", true],
		["Yes", true],
		["0", false],
		["false", false],
		["", false],
		[undefined, false],
		["no", false],
		["2", false],
	];
	for (const [val, expected] of cases) {
		it(`PI_FPS=${JSON.stringify(val)} -> ${expected}`, () => {
			expect(isFpsEnabled(val)).toBe(expected);
		});
	}

	it("defaults to process.env.PI_FPS when no argument is passed", () => {
		process.env.PI_FPS = "1";
		try {
			expect(isFpsEnabled()).toBe(true);
		} finally {
			if (orig === undefined) delete process.env.PI_FPS;
			else process.env.PI_FPS = orig;
		}
	});
});

describe("FpsTracker", () => {
	it("returns null until two frames are observed", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		expect(tracker.tick()).toBeNull();
		t = 16;
		expect(tracker.tick()).toBeCloseTo(1000 / 16, 1);
	});

	it("smooths FPS via EMA toward a steady rate", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		tracker.tick(); // t=0
		t = 10; // 100 fps instant
		tracker.tick(); // ema = 100
		t = 20; // 100 fps again
		const v = tracker.tick();
		expect(v).toBeCloseTo(100, 0);
	});

	it("shows a placeholder label before enough samples", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		expect(tracker.display()).toBe("FPS --");
		tracker.tick(); // only one frame so far
		expect(tracker.display()).toBe("FPS --");
	});

	it("shows a numeric FPS label after frames are painted", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		tracker.tick();
		t = 16;
		tracker.tick();
		expect(tracker.display()).toMatch(/^FPS \d+$/);
	});

	it("decays to FPS 0 once idle beyond the threshold", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		tracker.tick();
		t = 16;
		tracker.tick();
		expect(tracker.display()).toMatch(/^FPS \d+$/);
		t = 16 + 2000; // idle > 1500ms
		expect(tracker.display()).toBe("FPS 0");
	});

	it("ignores sub-threshold deltas to avoid divide-by-near-zero spikes", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		tracker.tick();
		t = 0.1; // below FPS_MIN_INTERVAL_MS
		expect(tracker.tick()).toBeNull();
	});

	it("current() mirrors the smoothed value (null until warmed up)", () => {
		let t = 0;
		const tracker = new FpsTracker(() => t);
		expect(tracker.current()).toBeNull();
		tracker.tick();
		t = 16;
		tracker.tick();
		expect(tracker.current()).toBeCloseTo(1000 / 16, 1);
	});
});
