import { afterEach, describe, expect, it } from "vitest";
import { getModelInfo, _resetModelInfoCacheForTests } from "../index.js";

// Build a fake registry ctx. `models` is the array getAvailable() returns.
// We control provider membership and contextWindow so the "isLatest" result
// depends on an actual sort — proving whether the sort ran or was cached.
function ctxWith(models: any[], activeModelId: string, activeName = activeModelId) {
	const active = models.find((m) => m.id === activeModelId) ?? models[0];
	return {
		model: active ? { ...active, name: activeName } : undefined,
		modelRegistry: { getAvailable: () => models },
	};
}

// Two same-provider models; the one with the larger contextWindow is "latest".
const MODELS = (winnerId: string) => [
	{ id: winnerId, provider: "p", contextWindow: 200_000, name: winnerId },
	{ id: "other", provider: "p", contextWindow: 100_000, name: "other" },
];

describe("getModelInfo memoization (no per-frame sort)", () => {
	afterEach(() => _resetModelInfoCacheForTests());

	it("computes isLatest from the highest-contextWindow model on a cold cache", () => {
		const ctx = ctxWith(MODELS("big"), "big");
		const info = getModelInfo(ctx);
		expect(info.isLatest).toBe(true);
	});

	it("does NOT re-sort when model.id and registry length are unchanged", () => {
		// Cold call with "big" as the winner.
		const ctx1 = ctxWith(MODELS("big"), "big");
		expect(getModelInfo(ctx1).isLatest).toBe(true);

		// Same model.id + SAME length, but a different underlying array where
		// "other" is now the higher-contextWindow model. If the sort re-ran we
		// would see isLatest flip to false. A cache hit keeps the old result.
		const ctx2 = ctxWith(MODELS("other"), "big");
		expect(getModelInfo(ctx2).isLatest).toBe(true); // cached, not recomputed
	});

	it("invalidates when the registry length changes (model added/removed)", () => {
		expect(getModelInfo(ctxWith(MODELS("big"), "big")).isLatest).toBe(true);
		// Add a third same-provider model with a larger window — length changes.
		const grown = [...MODELS("smallwinner"), { id: "huge", provider: "p", contextWindow: 300_000, name: "huge" }];
		const info = getModelInfo(ctxWith(grown, "big"));
		// Recomputed: "big" (200k) is no longer the max ("huge" is), so isLatest flips.
		expect(info.isLatest).toBe(false);
	});

	it("invalidates when the active model.id changes", () => {
		expect(getModelInfo(ctxWith(MODELS("big"), "big")).isLatest).toBe(true);
		// Switch active model to "other" (same registry length). Cache keyed on
		// model.id must miss and recompute.
		expect(getModelInfo(ctxWith(MODELS("big"), "other")).isLatest).toBe(false);
	});

	it("refreshes the displayed name every call without recomputing isLatest", () => {
		const ctx = ctxWith(MODELS("big"), "big", "first");
		expect(getModelInfo(ctx).name).toBe("first");
		// Same id/length → isLatest cached, but name reflects current model.name.
		const ctx2 = ctxWith(MODELS("big"), "big", "renamed");
		expect(getModelInfo(ctx2).name).toBe("renamed");
	});

	it("returns no-model sentinel when ctx.model is absent", () => {
		const ctx = { model: undefined, modelRegistry: { getAvailable: () => [] } };
		expect(getModelInfo(ctx)).toEqual({ name: "no model", isLatest: false });
	});
});
