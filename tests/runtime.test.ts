import { describe, expect, test } from "bun:test";
import { AdviseTool, runTurnBlock } from "../src/advice.ts";
import { AdvisorRuntime } from "../src/runtime.ts";

function buildIntegration({ onReview }: { onReview?: (text: string, ctx: { tool: AdviseTool; rt: AdvisorRuntime; reviewCount: number }) => Promise<void> } = {}) {
	const delivered: Array<Record<string, unknown>> = [];
	let rt: AdvisorRuntime;
	let reviewCount = 0;
	const state = { turn: "ended-nonterminal" };
	const tool = new AdviseTool((note, severity) => {
		if (rt && !rt.acceptingAdvice) return false;
		rt.enqueueAdvice(note, severity);
		return false;
	});
	const agent = {
		state: { messages: [] as unknown[], model: {} },
		async prompt(input: unknown) {
			await new Promise((r) => setTimeout(r, 0));
			reviewCount++;
			const text =
				typeof input === "string"
					? input
					: (input as Array<{ content: Array<{ text?: string }> }>)
							.map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text ?? "").join("\n") : ""))
							.join("\n\n");
			await onReview?.(text, { tool, rt, reviewCount });
			this.state.messages.push({ role: "assistant", content: [], usage: {}, stopReason: "stop" });
		},
		abort() {},
		reset() {
			this.state.messages = [];
		},
	};
	const deliverHeld = (notes: Array<{ note: string; severity?: string }>) => {
		for (const n of notes) {
			delivered.push({ ...n, kind: "held" });
			tool.markDelivered(n.note, n.severity as never);
		}
	};
	const flushNits = () => {
		for (const n of rt.takeNits()) {
			delivered.push({ ...n, kind: "nit", stale: true, finalAnswer: false });
			tool.markDelivered(n.note, n.severity);
		}
	};
	const onSettled = (outcome: "ok" | "failed") => {
		if (outcome !== "ok") return;
		if (state.turn === "ended-terminal") deliverHeld(rt.takeAllAdvice());
		else if (state.turn === "ended-nonterminal") flushNits();
	};
	rt = new AdvisorRuntime(agent as never, tool, 0, undefined, 80, onSettled);
	const block = (terminal: boolean, opts: Record<string, unknown> = {}) => {
		state.turn = terminal ? "ended-terminal" : "ended-nonterminal";
		if (!terminal) flushNits();
		return runTurnBlock({ terminal, runtime: rt, consecutiveBlocks: 0, notify: () => {}, deliverHeld, ...opts });
	};
	return { rt, tool, delivered, block, getReviewCount: () => reviewCount };
}

describe("AdvisorRuntime", () => {
	test("a nit is delivered during review, not held", async () => {
		const h = buildIntegration({
			onReview: async (_t, { tool, reviewCount }) => {
				if (reviewCount === 1) await tool.execute("n1", { note: "rename var", severity: "nit" });
			},
		});
		h.rt.push("turn 1");
		expect(await h.block(false)).toBe(0);
		await h.rt.waitUntilSettled(5000);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]!.kind).toBe("nit");
	});

	test("blocker held on turn 1 is delivered after terminal reconfirm", async () => {
		const h = buildIntegration({
			onReview: async (text, { tool, reviewCount }) => {
				if (reviewCount === 1) await tool.execute("a1", { note: "off-by-one", severity: "blocker" });
				else if (reviewCount === 2) {
					expect(text).toContain("Held advisories");
					await tool.execute("a2", { note: "off-by-one", severity: "blocker" });
				}
			},
		});
		h.rt.push("turn 1");
		expect(await h.block(false)).toBe(0);
		await h.rt.waitUntilSettled(5000);
		expect(h.rt.hasHighPriority).toBe(true);
		h.rt.push("turn 2");
		expect(await h.block(true)).toBe(0);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]!.severity).toBe("blocker");
	});

	test("recanted blocker is dropped", async () => {
		const h = buildIntegration({
			onReview: async (_text, { tool, reviewCount }) => {
				if (reviewCount === 1) await tool.execute("a1", { note: "off-by-one", severity: "blocker" });
			},
		});
		h.rt.push("turn 1");
		await h.block(false);
		await h.rt.waitUntilSettled(5000);
		h.rt.push("turn 2");
		expect(await h.block(true)).toBe(0);
		expect(h.delivered).toHaveLength(0);
	});

	test("orphaned review does not poison fresh-epoch dedup", async () => {
		const h = buildIntegration({
			onReview: async (_t, { tool, rt, reviewCount }) => {
				if (reviewCount === 1) {
					rt.reset();
					await tool.execute("a1", { note: "same blocker", severity: "blocker" });
				} else if (reviewCount === 2) {
					const result = await tool.execute("a2", { note: "same blocker", severity: "blocker" });
					expect((result.content[0] as { text: string }).text).not.toContain("Duplicate");
				}
			},
		});
		h.rt.push("turn 1");
		await h.block(false);
		await h.rt.waitUntilSettled(2000);
		h.rt.push("fresh turn");
		await h.block(false);
		await h.rt.waitUntilSettled(2000);
		expect(h.rt.hasHighPriority).toBe(true);
	});

	test("provider error stopReason fails the review and preserves holds", async () => {
		let attempts = 0;
		const agent = {
			state: { messages: [] as unknown[], model: {} },
			async prompt() {
				attempts++;
				this.state.messages.push({ role: "assistant", content: [], usage: {}, stopReason: "error", errorMessage: "503" });
			},
			abort() {},
			reset() {},
		};
		const rt = new AdvisorRuntime(agent as never, new AdviseTool(() => false), 0);
		rt.enqueueAdvice("data race", "blocker");
		rt.push("turn");
		expect(await rt.waitUntilSettled(2000)).toBe("failed");
		expect(attempts).toBe(3);
		expect(rt.hasHighPriority).toBe(true);
	});

	test("fresh overflow fails after one reactive compact per retry", async () => {
		let attempts = 0;
		let resets = 0;
		const agent = {
			state: { messages: [] as unknown[], model: {} },
			async prompt() {
				attempts++;
				this.state.messages.push({ role: "assistant", content: [], usage: {}, stopReason: "length" });
			},
			abort() {},
			reset() {
				resets++;
				this.state.messages = [];
			},
		};
		const rt = new AdvisorRuntime(agent as never, new AdviseTool(() => false), 0);
		rt.enqueueAdvice("data race", "blocker");
		rt.push("turn");
		expect(await rt.waitUntilSettled(2000)).toBe("failed");
		expect(attempts).toBe(6);
		expect(resets).toBe(3);
		expect(rt.hasHighPriority).toBe(true);
	});

	test("proactive self-compaction preserves lifetime cost", async () => {
		const promptMsgCounts: number[] = [];
		const agent = {
			state: {
				messages: [{ role: "assistant", content: [], usage: { input: 90000, cost: { total: 0.5 } }, stopReason: "stop" }],
				model: { contextWindow: 100000 },
			},
			async prompt() {
				promptMsgCounts.push(this.state.messages.length);
				this.state.messages.push({ role: "assistant", content: [], usage: { input: 5, cost: { total: 0.01 } }, stopReason: "stop" });
			},
			abort() {},
			reset() {
				this.state.messages = [];
			},
		};
		const rt = new AdvisorRuntime(agent as never, new AdviseTool(() => false), 0);
		rt.push("turn");
		expect(await rt.waitUntilSettled(2000)).toBe("settled");
		expect(promptMsgCounts[0]).toBe(0);
		expect(rt.usage.cost).toBeCloseTo(0.51);
	});

	test("queue dedupes, escalates, splits nits, and resets", () => {
		const agent = { state: { messages: [], model: {} }, abort() {}, reset() {}, async prompt() {} };
		const rt = new AdvisorRuntime(agent as never, new AdviseTool(() => false), 0);
		rt.enqueueAdvice("shared mutation", "nit");
		rt.enqueueAdvice("shared   mutation", "blocker");
		rt.enqueueAdvice("small cleanup", "nit");
		expect(rt.takeNits()).toEqual([{ note: "small cleanup", severity: "nit" }]);
		expect(rt.takeAllAdvice()).toEqual([{ note: "shared mutation", severity: "blocker" }]);
		rt.enqueueAdvice("old transcript", "nit");
		rt.reset();
		expect(rt.takeAllAdvice()).toEqual([]);
	});
});
