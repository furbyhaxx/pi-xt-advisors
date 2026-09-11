import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AdvisorSession, advisorSessionPath } from "../src/session.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("advisor session sidecar", () => {
	test("maps next to the observed file and stays out of SessionManager.list", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-session-"));
		dirs.push(root);
		const cwd = join(root, "proj");
		mkdirSync(cwd);
		const primary = SessionManager.create(cwd, join(root, "sessions"));
		primary.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "openai-completions",
			provider: "mock",
			model: "mock",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		const file = primary.getSessionFile();
		expect(file).toBeTruthy();
		const sidecar = advisorSessionPath(file!);
		expect(sidecar).toBe(join(root, "sessions", "advisor", file!.split("/").pop()!));

		const session = AdvisorSession.open({ cwd, file, id: primary.getSessionId() });
		session.appendMessage({ role: "user", content: [{ type: "text", text: "review me" }], timestamp: Date.now() });
		session.checkpoint({
			version: 1,
			kind: "review-complete",
			heldAdvice: [{ note: "watch this", severity: "concern" }],
			delivered: [["watch this", 2]],
			reviewedEntryIds: ["abc"],
			reviewOutcome: "ok",
		});
		await session.flush();
		session.close();

		expect(existsSync(sidecar)).toBe(true);
		const listed = await SessionManager.list(cwd, join(root, "sessions"));
		expect(listed.some((s) => s.path.includes(`${join("sessions", "advisor")}`))).toBe(false);
		expect(readdirSync(join(root, "sessions")).includes("advisor")).toBe(true);

		const reopened = AdvisorSession.open({ cwd, file, id: primary.getSessionId() });
		const restored = reopened.restore();
		expect(restored.heldAdvice).toEqual([{ note: "watch this", severity: "concern" }]);
		expect(restored.delivered).toEqual([["watch this", 2]]);
		expect(restored.messages.some((m) => m.role === "user")).toBe(true);
		reopened.close();
	});

	test("ephemeral observed sessions stay ephemeral", () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-eph-"));
		dirs.push(root);
		const session = AdvisorSession.open({ cwd: root });
		expect(session.persisted).toBe(false);
		expect(session.path).toBeUndefined();
		session.close();
	});

	test("does not overwrite a malformed sidecar", () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-bad-"));
		dirs.push(root);
		const sessions = join(root, "sessions");
		mkdirSync(join(sessions, "advisor"), { recursive: true });
		const file = join(sessions, "x.jsonl");
		writeFileSync(file, "{}\n");
		const sidecar = advisorSessionPath(file);
		writeFileSync(sidecar, "not-json\n");
		expect(() => AdvisorSession.open({ cwd: root, file })).toThrow();
		expect(readFileSync(sidecar, "utf8")).toBe("not-json\n");
	});
});
