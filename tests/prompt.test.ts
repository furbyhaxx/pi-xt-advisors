import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeToolAccess, loadAdvisorPrompt } from "../src/prompt.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("prompt composition", () => {
	test("project ADVISOR_SYSTEM.md wins over user, append is independent", () => {
		const agent = mkdtempSync(join(tmpdir(), "advisor-prompt-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "advisor-prompt-cwd-"));
		dirs.push(agent, cwd);
		process.env.PI_CODING_AGENT_DIR = agent;
		writeFileSync(join(agent, "ADVISOR_SYSTEM.md"), "USER BASE");
		writeFileSync(join(agent, "ADVISOR_APPEND_SYSTEM.md"), "USER APPEND");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "ADVISOR_SYSTEM.md"), "PROJECT BASE");
		writeFileSync(join(cwd, "WATCHDOG.md"), "watch this");

		const untrusted = loadAdvisorPrompt({ cwd, projectTrusted: false, instructions: "from-settings" });
		expect(untrusted.base).toBe("user");
		expect(untrusted.text).toContain("USER BASE");
		expect(untrusted.text).toContain("USER APPEND");
		expect(untrusted.text).not.toContain("watch this");
		expect(untrusted.text.endsWith("from-settings")).toBe(true);

		const trusted = loadAdvisorPrompt({ cwd, projectTrusted: true, instructions: "from-settings" });
		expect(trusted.base).toBe("project");
		expect(trusted.append).toBe("user");
		expect(trusted.text).toContain("PROJECT BASE");
		expect(trusted.text).toContain("USER APPEND");
		expect(trusted.text).toContain("watch this");
		expect(trusted.text).toContain("from-settings");
	});

	test("describeToolAccess reflects write tools", () => {
		expect(describeToolAccess(["read", "grep"])).toContain("read-only");
		expect(describeToolAccess(["read", "bash"])).toContain("Writing or running commands");
	});
});
