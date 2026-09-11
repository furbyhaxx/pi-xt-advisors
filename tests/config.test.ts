import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseAdvisorObject, saveAdvisorSettings } from "../src/config.ts";

const dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), "advisor-config-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseAdvisorObject", () => {
	test("rejects non-objects and invalid leaves", () => {
		expect(parseAdvisorObject("x", "user").diagnostics.length).toBeGreaterThan(0);
		expect(parseAdvisorObject({ model: 1 }, "user").diagnostics).toContain("user: model must be a string in provider/model[:thinking] form");
		expect(parseAdvisorObject({ compact: { pct: 10 } }, "user").diagnostics.length).toBeGreaterThan(0);
		expect(parseAdvisorObject({ compact: { pct: 80 } }, "user").value.compactPct).toBe(80);
	});

	test("empty tools array is a real override", () => {
		expect(parseAdvisorObject({ tools: [] }, "user").value.tools).toEqual([]);
	});
});

describe("load/save settings", () => {
	test("merges user < project, preserves unrelated keys, and respects trust", () => {
		const agent = tempDir();
		const cwd = tempDir();
		process.env.PI_CODING_AGENT_DIR = agent;
		writeFileSync(
			join(agent, "settings.json"),
			JSON.stringify({ theme: "dark", advisor: { debug: true, review: true, model: "openrouter/a/b" } }, null, 2),
		);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ advisor: { review: false, compact: { pct: 70 } } }, null, 2));

		const untrusted = loadConfig(cwd, false);
		expect(untrusted.effective.debug).toBe(true);
		expect(untrusted.effective.review).toBe(true);
		expect(untrusted.provenance.review).toBe("user");

		const trusted = loadConfig(cwd, true);
		expect(trusted.effective.review).toBe(false);
		expect(trusted.effective.compactPct).toBe(70);
		expect(trusted.provenance.review).toBe("project");
		expect(trusted.effective.debug).toBe(true);

		const saved = saveAdvisorSettings("user", cwd, { debug: false });
		expect(saved.ok).toBe(true);
		const raw = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
		expect(raw.theme).toBe("dark");
		expect(raw.advisor.debug).toBe(false);
		expect(raw.advisor.model).toBe("openrouter/a/b");
		delete process.env.PI_CODING_AGENT_DIR;
	});

	test("inherit removes a leaf rather than writing defaults", () => {
		const agent = tempDir();
		process.env.PI_CODING_AGENT_DIR = agent;
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ advisor: { debug: true } }, null, 2));
		expect(saveAdvisorSettings("user", agent, { debug: null }).ok).toBe(true);
		const raw = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
		expect(raw.advisor).toBeUndefined();
		delete process.env.PI_CODING_AGENT_DIR;
	});
});
