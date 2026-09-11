import { describe, expect, test } from "bun:test";
import {
	AdviseTool,
	formatAdvisoryContent,
	formatReconfirmPreamble,
	isHighSeverity,
	isTerminalTurn,
	nextBackoffMs,
	parseAdvisorTestArgs,
	runTurnBlock,
} from "../src/advice.ts";

describe("advice helpers", () => {
	test("isHighSeverity: only concern/blocker are held + reconfirmed", () => {
		expect(isHighSeverity(undefined)).toBe(false);
		expect(isHighSeverity("nit")).toBe(false);
		expect(isHighSeverity("concern")).toBe(true);
		expect(isHighSeverity("blocker")).toBe(true);
	});

	test("nextBackoffMs: base, doubling, capped, guarded", () => {
		expect(nextBackoffMs(0, 15000, 120000)).toBe(15000);
		expect(nextBackoffMs(1, 15000, 120000)).toBe(30000);
		expect(nextBackoffMs(2, 15000, 120000)).toBe(60000);
		expect(nextBackoffMs(3, 15000, 120000)).toBe(120000);
		expect(nextBackoffMs(4, 15000, 120000)).toBe(120000);
		expect(nextBackoffMs(-1, 15000, 120000)).toBe(15000);
		expect(nextBackoffMs(0)).toBe(15000);
	});

	test("isTerminalTurn: terminal iff the assistant message made no tool calls", () => {
		expect(isTerminalTurn({ content: [{ type: "text" }] })).toBe(true);
		expect(isTerminalTurn({ content: [] })).toBe(true);
		expect(isTerminalTurn(undefined)).toBe(true);
		expect(isTerminalTurn({ content: [{ type: "toolCall" }] })).toBe(false);
		expect(isTerminalTurn({ content: [{ type: "text" }, { type: "toolCall" }] })).toBe(false);
	});

	test("formatReconfirmPreamble", () => {
		expect(formatReconfirmPreamble([])).toBe("");
		const p = formatReconfirmPreamble([
			{ note: "races on shared map", severity: "blocker" },
			{ note: "missing await", severity: "concern" },
		]);
		expect(p).toContain("Held advisories — reconfirm");
		expect(p).toContain("call `advise` again");
		expect(p).toContain("- [BLOCKER] races on shared map");
		expect(p).toContain("- [CONCERN] missing await");
	});

	test("parseAdvisorTestArgs", () => {
		expect(parseAdvisorTestArgs("test nit be tidy")).toEqual({ severity: "nit", note: "be tidy" });
		expect(parseAdvisorTestArgs("test  concern   wrong path here")).toEqual({
			severity: "concern",
			note: "wrong path here",
		});
		expect(parseAdvisorTestArgs("test BLOCKER STOP NOW")).toEqual({ severity: "blocker", note: "STOP NOW" });
		expect(parseAdvisorTestArgs("test")).toBeNull();
		expect(parseAdvisorTestArgs("test nit")).toBeNull();
		expect(parseAdvisorTestArgs("status")).toBeNull();
	});

	test("formatAdvisoryContent wraps, escapes, and optional flags", () => {
		const c = formatAdvisoryContent([{ note: "use <T> & stuff", severity: "concern" }]);
		expect(c).toContain('<advisory severity="concern" guidance="weigh, don\'t blindly obey">');
		expect(c).toContain("use &lt;T&gt; &amp; stuff");
		expect(formatAdvisoryContent([{ note: "tidy up" }])).not.toContain("severity=");
		expect(formatAdvisoryContent([{ note: "rename", severity: "nit" }], { stale: true })).toContain(
			'context="raised about an earlier step"',
		);
		expect(formatAdvisoryContent([{ note: "fix bug", severity: "blocker" }], { finalAnswer: true })).toContain(
			"self-contained final answer",
		);
	});
});

describe("AdviseTool", () => {
	test("records, dedups, and escalates by severity rank", async () => {
		const calls: Array<{ note: string; severity?: string }> = [];
		const tool = new AdviseTool((note, severity) => {
			calls.push({ note, severity });
			return true;
		});
		const r1 = await tool.execute("c1", { note: "guard empty array", severity: "nit" });
		expect(r1.content[0]).toEqual({ type: "text", text: "Recorded." });
		const r2 = await tool.execute("c2", { note: "guard empty array", severity: "nit" });
		expect((r2.content[0] as { text: string }).text).toContain("Duplicate");
		await tool.execute("c3", { note: "guard   empty\narray", severity: "nit" });
		await tool.execute("c4", { note: "guard empty array", severity: "concern" });
		expect(calls).toHaveLength(2);
		tool.resetDelivered();
		await tool.execute("c6", { note: "guard empty array", severity: "nit" });
		expect(calls).toHaveLength(3);
	});

	test("held notes stay unrecorded so they can re-fire", async () => {
		let deliver = false;
		const calls: unknown[] = [];
		const tool = new AdviseTool((note, severity) => {
			calls.push({ note, severity });
			return deliver;
		});
		const r1 = await tool.execute("h1", { note: "data race", severity: "blocker" });
		expect((r1.content[0] as { text: string }).text).toContain("Queued for boundary");
		await tool.execute("h2", { note: "data race", severity: "blocker" });
		expect(calls).toHaveLength(2);
		deliver = true;
		await tool.execute("h3", { note: "data race", severity: "blocker" });
		await tool.execute("h4", { note: "data race", severity: "blocker" });
		expect(calls).toHaveLength(3);
	});

	test("markDelivered records dedup at the real delivery point", async () => {
		const calls: unknown[] = [];
		const tool = new AdviseTool((note, severity) => {
			calls.push({ note, severity });
			return false;
		});
		tool.markDelivered("data race", "blocker");
		const r = await tool.execute("x", { note: "data race", severity: "blocker" });
		expect((r.content[0] as { text: string }).text).toContain("Duplicate");
		expect(calls).toHaveLength(0);
	});
});

function stubRuntime({ held = [], settleResult = "settled" }: { held?: Array<{ note: string; severity?: string }>; settleResult?: "settled" | "timeout" | "aborted" | "failed" } = {}) {
	return {
		_held: [...held],
		waited: false,
		get hasHighPriority() {
			return this._held.some((n) => n.severity === "concern" || n.severity === "blocker");
		},
		takeAllAdvice() {
			return this._held.splice(0);
		},
		requeueAdvice(note: string, severity?: string) {
			this._held.push({ note, severity });
		},
		async waitUntilSettled() {
			this.waited = true;
			return settleResult;
		},
	};
}

describe("runTurnBlock", () => {
	const blockArgs = (over: Record<string, unknown>) => ({
		consecutiveBlocks: 0,
		notify: () => {},
		deliverHeld: () => {},
		...over,
	});

	test("non-terminal with nothing held → no block", async () => {
		const rt = stubRuntime({ held: [] });
		const n = await runTurnBlock(blockArgs({ terminal: false, runtime: rt, consecutiveBlocks: 3 }) as never);
		expect(n).toBe(0);
		expect(rt.waited).toBe(false);
	});

	test("terminal timeout delivers only concerns/blockers", async () => {
		const delivered: unknown[] = [];
		const rt = stubRuntime({
			held: [
				{ note: "x", severity: "concern" },
				{ note: "y", severity: "nit" },
			],
			settleResult: "timeout",
		});
		const n = await runTurnBlock(
			blockArgs({ terminal: true, runtime: rt, deliverHeld: (x: unknown[]) => delivered.push(...x) }) as never,
		);
		expect(n).toBe(0);
		expect(delivered).toEqual([{ note: "x", severity: "concern" }]);
		expect(rt._held).toEqual([{ note: "y", severity: "nit" }]);
	});

	test("aborted keeps held + streak", async () => {
		const delivered: unknown[] = [];
		const rt = stubRuntime({ held: [{ note: "x", severity: "blocker" }], settleResult: "aborted" });
		const n = await runTurnBlock(
			blockArgs({ terminal: false, runtime: rt, consecutiveBlocks: 2, deliverHeld: (x: unknown[]) => delivered.push(...x) }) as never,
		);
		expect(n).toBe(2);
		expect(delivered).toHaveLength(0);
	});
});
