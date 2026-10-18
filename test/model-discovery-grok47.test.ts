import { readFileSync } from "node:fs";
import type { ModelListItem } from "@cursor/sdk";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testUtils, buildCursorModelSelection, getCursorModelMetadata, getCursorModelMetadataEntries } from "../src/model-discovery.js";

vi.mock("../src/context-window-cache.js", () => ({ loadContextWindowCache: () => new Map() }));

// Exact parent-captured catalog, not a reconstructed mock. Provenance is retained
// in the fixture; alias/default mutations below are synthetic boundary cases.
const { model: captured } = JSON.parse(readFileSync(new URL("./fixtures/grok47-catalog.json", import.meta.url), "utf8")) as { model: ModelListItem };
const matrix = captured.variants!.map(({ params }) => ({
	context: params.find(({ id }) => id === "context")!.value,
	effort: params.find(({ id }) => id === "reasoning_effort")!.value as ModelThinkingLevel,
	fast: params.find(({ id }) => id === "fast")!.value === "true",
	params,
}));

function grok(): ModelListItem {
	return structuredClone(captured);
}

describe("Grok 4.7 captured catalog selection", () => {
	beforeEach(() => { __testUtils.registerModelItems([grok()]); });

	it.each(matrix)("selects $context / $effort / fast=$fast without the rejected default context", ({ context, effort, fast, params }) => {
		expect(buildCursorModelSelection(`grok-4.7@${context}`, effort, fast)).toEqual({
			id: "grok-4.7",
			params: context === "500k" ? params.filter(({ id }) => id !== "context") : params,
		});
	});

	it("exposes native Pi thinking levels without inventing off, minimal or max", () => {
		expect(getCursorModelMetadata("grok-4.7@500k")?.thinkingLevelMap).toEqual({
			off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
		});
	});

	it.each(["off", "minimal", "max"] as const)("keeps catalog effort/fast defaults for unsupported %s", (level) => {
		expect(buildCursorModelSelection("grok-4.7@500k", level)).toEqual({
			id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }],
		});
	});

	it("does not mutate catalog, metadata, or selected windows when omitting outgoing context", () => {
		const item = grok();
		const models = __testUtils.registerModelItems([item]);
		const before = getCursorModelMetadataEntries();
		buildCursorModelSelection("grok-4.7@500k", "low", false);
		buildCursorModelSelection("grok-4.7@256k", "xhigh", true);
		expect(item).toEqual(captured);
		expect(getCursorModelMetadataEntries()).toEqual(before);
		for (const [context, window] of [["500k", 500000], ["256k", 256000]] as const) {
			expect(models.find(({ id }) => id === `grok-4.7@${context}`)?.contextWindow).toBe(window);
			expect(getCursorModelMetadata(`grok-4.7@${context}`)).toMatchObject({
				context, contextWindow: window,
				defaultParams: [{ id: "context", value: context }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }],
			});
		}
	});

	it.each([
		["grok-latest@500k:slow", "grok-latest", false, undefined],
		["grok-latest@256k:fast", "grok-latest", true, "256k"],
		["grok-4.7@500k:fast", "grok-4.7", true, undefined],
	] as const)("uses base model identity for %s while preserving alias and speed", (modelId, selectionId, fast, context) => {
		__testUtils.registerModelItems([{ ...grok(), aliases: ["grok-latest"] }]);
		expect(buildCursorModelSelection(modelId, "medium")).toEqual({
			id: selectionId,
			params: [...(context ? [{ id: "context", value: context }] : []), { id: "reasoning_effort", value: "medium" }, { id: "fast", value: String(fast) }],
		});
	});

	it("replaces stale catalog-default metadata on refresh instead of hardcoding 500k", () => {
		const refreshed = grok();
		refreshed.variants!.find(({ isDefault }) => isDefault)!.params.find(({ id }) => id === "context")!.value = "256k";
		__testUtils.registerModelItems([refreshed]);
		expect(buildCursorModelSelection("grok-4.7@256k", "high").params).toEqual([
			{ id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" },
		]);
		expect(buildCursorModelSelection("grok-4.7@500k", "high").params).toEqual([
			{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" },
		]);
	});

	it.each(["256k", "500k"])("keeps %s explicit when catalog default has no context", (context) => {
		const item = grok();
		const defaultVariant = item.variants!.find(({ isDefault }) => isDefault)!;
		defaultVariant.params = defaultVariant.params.filter(({ id }) => id !== "context");
		__testUtils.registerModelItems([item]);
		expect(buildCursorModelSelection(`grok-4.7@${context}`, "high").params).toContainEqual({ id: "context", value: context });
	});

	it.each(["grok-4.6", "unrelated-model"])("keeps redundant defaults explicit for %s, even with a grok-4.7 alias", (id) => {
		__testUtils.registerModelItems([{ ...grok(), id, aliases: ["grok-4.7"] }]);
		expect(buildCursorModelSelection("grok-4.7@500k", "high")).toEqual({
			id: "grok-4.7",
			params: [{ id: "context", value: "500k" }, { id: "reasoning_effort", value: "high" }, { id: "fast", value: "true" }],
		});
	});
});
