import { describe, expect, test } from "bun:test";
import { formatAdvisorModelSpec, parseAdvisorModelSpec, resolveAdvisorModel } from "../src/model.ts";

describe("parseAdvisorModelSpec", () => {
	test("splits provider/model and optional thinking", () => {
		expect(parseAdvisorModelSpec("openrouter/z-ai/glm-5.2:low")).toEqual({
			provider: "openrouter",
			modelId: "z-ai/glm-5.2",
			thinkingLevel: "low",
			fullModelId: "z-ai/glm-5.2:low",
		});
		expect(parseAdvisorModelSpec("openrouter/openai/gpt-5.6-sol:low")?.modelId).toBe("openai/gpt-5.6-sol");
		expect(parseAdvisorModelSpec("bad")).toBeNull();
	});

	test("keeps colon suffixes that are not thinking levels", () => {
		expect(parseAdvisorModelSpec("openrouter/foo/bar:exacto")).toEqual({
			provider: "openrouter",
			modelId: "foo/bar:exacto",
			fullModelId: "foo/bar:exacto",
		});
	});
});

describe("resolveAdvisorModel", () => {
	test("prefers exact id then thinking suffix", () => {
		const models = [
			{ provider: "openrouter", id: "z-ai/glm-5.2", reasoning: true },
			{ provider: "openrouter", id: "foo/bar:exacto", reasoning: false },
		];
		const registry = {
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		};
		const ok = resolveAdvisorModel(registry as never, "openrouter/z-ai/glm-5.2:low");
		expect("error" in ok).toBe(false);
		if (!("error" in ok)) {
			expect(ok.model.id).toBe("z-ai/glm-5.2");
			expect(ok.thinkingLevel).toBe("low");
		}
		const exacto = resolveAdvisorModel(registry as never, "openrouter/foo/bar:exacto");
		expect("error" in exacto).toBe(false);
		const missing = resolveAdvisorModel(registry as never, "openrouter/nope");
		expect("error" in missing).toBe(true);
	});

	test("formatAdvisorModelSpec", () => {
		expect(formatAdvisorModelSpec({ provider: "openrouter", id: "a/b" } as never, "low")).toBe("openrouter/a/b:low");
		expect(formatAdvisorModelSpec({ provider: "openrouter", id: "a/b" } as never, "off")).toBe("openrouter/a/b");
	});
});
