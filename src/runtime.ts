import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AdviseTool, type AdvisorNote, type AdvisorSeverity, dedupeKey, formatReconfirmPreamble, isHighSeverity, rankOf } from "./advice.ts";
import { buildReviewMessages } from "./transcript.ts";
import type { AdvisorAgentLike } from "./model.ts";

export interface RuntimeUsage {
	input: number;
	output: number;
	cost: number;
	contextTokens: number;
	contextPercent: number | null;
}

export interface AdvisorRuntimeHooks {
	onSoftReset?: () => void;
	onReviewStart?: (batch: string[], preamble: string) => void;
	onReviewComplete?: (outcome: "ok" | "failed") => void;
}

export class AdvisorRuntime {
	#pending: string[] = [];
	#advice: AdvisorNote[] = [];
	#reraised: Set<string> | undefined;
	#lastOutcome: "ok" | "failed" | undefined;
	#reviewEpoch = -1;
	#settleWaiters: Array<{ settle: () => void; cancel: () => void }> = [];
	#busy = false;
	#backlog = 0;
	#failures = 0;
	#epoch = 0;
	#cumInput = 0;
	#cumOutput = 0;
	#cumCost = 0;
	disposed = false;
	private readonly compactAtPercent: number;

	constructor(
		private readonly agent: AdvisorAgentLike,
		private readonly adviseTool: AdviseTool,
		private readonly retryDelayMs = 1000,
		private readonly onDebug?: (...a: unknown[]) => void,
		compactAtPercent = 80,
		private readonly onSettled?: (outcome: "ok" | "failed") => void,
		private readonly hooks?: AdvisorRuntimeHooks,
	) {
		this.compactAtPercent = compactAtPercent;
	}

	#softReset(): void {
		for (const m of this.agent.state.messages) {
			if (m.role === "assistant" && (m as AssistantMessage).usage) {
				const u = (m as AssistantMessage).usage;
				this.#cumInput += u.input ?? 0;
				this.#cumOutput += u.output ?? 0;
				this.#cumCost += u.cost?.total ?? 0;
			}
		}
		try {
			this.hooks?.onSoftReset?.();
		} catch (e) {
			this.onDebug?.("advisor onSoftReset threw", String(e));
		}
		try {
			this.agent.abort();
		} catch {}
		try {
			this.agent.reset();
		} catch {}
	}

	get backlog(): number {
		return this.#backlog;
	}

	get idle(): boolean {
		return !this.#busy && this.#pending.length === 0;
	}

	get hasHighPriority(): boolean {
		return this.#advice.some((n) => isHighSeverity(n.severity));
	}

	get lastOutcome(): "ok" | "failed" | undefined {
		return this.#lastOutcome;
	}

	snapshotAdvice(): AdvisorNote[] {
		return this.#advice.map((n) => ({ ...n }));
	}

	hydrateAdvice(notes: AdvisorNote[]): void {
		this.#advice = notes.map((n) => ({ ...n }));
	}

	hydrateAccounting(usage: { input: number; output: number; cost: number }): void {
		this.#cumInput = usage.input;
		this.#cumOutput = usage.output;
		this.#cumCost = usage.cost;
	}

	#upsertAdvice(note: string, severity?: AdvisorSeverity): void {
		if (this.disposed) return;
		const key = dedupeKey(note);
		const existing = this.#advice.find((n) => dedupeKey(n.note) === key);
		if (!existing) this.#advice.push({ note, severity });
		else if (rankOf(severity) > rankOf(existing.severity)) existing.severity = severity;
	}

	enqueueAdvice(note: string, severity?: AdvisorSeverity): void {
		if (this.disposed) return;
		this.#reraised?.add(dedupeKey(note));
		this.#upsertAdvice(note, severity);
	}

	requeueAdvice(note: string, severity?: AdvisorSeverity): void {
		this.#upsertAdvice(note, severity);
	}

	takeNits(): AdvisorNote[] {
		const nits = this.#advice.filter((n) => !isHighSeverity(n.severity));
		this.#advice = this.#advice.filter((n) => isHighSeverity(n.severity));
		return nits;
	}

	takeAllAdvice(): AdvisorNote[] {
		return this.#advice.splice(0);
	}

	get acceptingAdvice(): boolean {
		return !this.disposed && this.#reviewEpoch === this.#epoch;
	}

	waitUntilSettled(timeoutMs: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "aborted" | "failed"> {
		if (this.disposed) return Promise.resolve("aborted");
		if (this.idle) return Promise.resolve(this.#lastOutcome === "failed" ? "failed" : "settled");
		return new Promise((resolve) => {
			let done = false;
			let waiter: { settle: () => void; cancel: () => void };
			let timer: ReturnType<typeof setTimeout>;
			const finish = (r: "settled" | "timeout" | "aborted" | "failed") => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				const i = this.#settleWaiters.indexOf(waiter);
				if (i >= 0) this.#settleWaiters.splice(i, 1);
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			};
			const onAbort = () => finish("aborted");
			waiter = {
				settle: () => {
					if (this.disposed) finish("aborted");
					else if (this.idle) finish(this.#lastOutcome === "failed" ? "failed" : "settled");
				},
				cancel: () => finish("aborted"),
			};
			timer = setTimeout(() => finish("timeout"), timeoutMs);
			this.#settleWaiters.push(waiter);
			if (signal) {
				if (signal.aborted) finish("aborted");
				else signal.addEventListener("abort", onAbort);
			}
		});
	}

	#notifySettled(): void {
		for (const w of [...this.#settleWaiters]) w.settle();
	}

	#cancelWaiters(): void {
		for (const w of [...this.#settleWaiters]) w.cancel();
	}

	get usage(): RuntimeUsage {
		let input = this.#cumInput;
		let output = this.#cumOutput;
		let cost = this.#cumCost;
		let contextTokens = 0;
		for (const m of this.agent.state.messages) {
			if (m.role === "assistant" && (m as AssistantMessage).usage) {
				const u = (m as AssistantMessage).usage;
				input += u.input ?? 0;
				output += u.output ?? 0;
				cost += u.cost?.total ?? 0;
				contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			}
		}
		const window = (this.agent.state.model as { contextWindow?: number } | undefined)?.contextWindow;
		const contextPercent = window ? Math.round((contextTokens / window) * 100) : null;
		return { input, output, cost, contextTokens, contextPercent };
	}

	push(deltaText: string): void {
		if (this.disposed || !deltaText.trim()) return;
		this.#pending.push(deltaText);
		this.#backlog++;
		void this.#drain();
	}

	reset(): void {
		this.#epoch++;
		this.#pending = [];
		this.#advice = [];
		this.#reraised = undefined;
		this.#lastOutcome = undefined;
		this.#backlog = 0;
		this.#failures = 0;
		this.#cumInput = this.#cumOutput = this.#cumCost = 0;
		this.adviseTool.resetDelivered();
		try {
			this.agent.abort();
		} catch {}
		try {
			this.agent.reset();
		} catch {}
		this.#cancelWaiters();
	}

	dispose(): void {
		this.disposed = true;
		this.#epoch++;
		this.#pending = [];
		this.#advice = [];
		this.#reraised = undefined;
		this.#lastOutcome = undefined;
		this.#backlog = 0;
		try {
			this.agent.abort();
		} catch {}
		this.#cancelWaiters();
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.disposed && this.#pending.length) {
				const batch = this.#pending.splice(0);
				const turns = batch.length;
				this.#backlog = Math.max(0, this.#backlog - turns);
				const epoch = this.#epoch;
				const offered = this.#advice.map((n) => ({ ...n }));
				const offeredKeys = new Set(offered.map((n) => dedupeKey(n.note)));
				const preamble = formatReconfirmPreamble(offered);
				this.#reraised = new Set();
				this.#reviewEpoch = epoch;
				const messages = buildReviewMessages(preamble, batch);
				const promptChars = messages.reduce(
					(n, m) =>
						n +
						(Array.isArray(m.content)
							? m.content.reduce(
									(k: number, b: { type: string; text?: string }) => k + (b.type === "text" ? (b.text?.length ?? 0) : 0),
									0,
								)
							: 0),
					0,
				);
				let failed = false;
				const pct = this.usage.contextPercent;
				if (pct !== null && pct >= this.compactAtPercent && this.agent.state.messages.length > 0) {
					this.onDebug?.("advisor self-compacting (proactive), ctx=", pct, "% >=", this.compactAtPercent, "%");
					this.#softReset();
				}
				try {
					this.hooks?.onReviewStart?.(batch, preamble);
				} catch (e) {
					this.onDebug?.("advisor onReviewStart threw", String(e));
				}
				let stale = false;
				try {
					let last: AssistantMessage | undefined;
					for (let attempt = 0; attempt < 2; attempt++) {
						this.onDebug?.("prompting advisor agent, delta chars=", promptChars, "held=", offered.length);
						await this.agent.prompt(messages);
						if (this.#epoch !== epoch) {
							stale = true;
							break;
						}
						last = this.agent.state.messages[this.agent.state.messages.length - 1] as AssistantMessage;
						if (last?.stopReason === "length" && attempt === 0) {
							this.onDebug?.("advisor context overflow, self-compacting (reactive) and replaying batch fresh");
							this.#softReset();
							const before = new Map(offered.map((n) => [dedupeKey(n.note), n]));
							this.#advice = this.#advice.flatMap((current) => {
								const prior = before.get(dedupeKey(current.note));
								return prior ? [{ ...current, severity: prior.severity }] : [];
							});
							this.#reraised = new Set();
							continue;
						}
						break;
					}
					if (stale) {
						this.#reraised = undefined;
						continue;
					}
					if (last?.stopReason === "error" || last?.stopReason === "aborted" || last?.stopReason === "length") {
						this.onDebug?.("advisor review incomplete, stop=", last?.stopReason, "err=", last?.errorMessage ?? "-");
						failed = true;
					} else {
						for (const key of offeredKeys) {
							if (!this.#reraised?.has(key)) {
								const i = this.#advice.findIndex((n) => dedupeKey(n.note) === key);
								if (i >= 0) this.#advice.splice(i, 1);
							}
						}
						this.#lastOutcome = "ok";
						this.#failures = 0;
						this.onDebug?.("advisor turn done, stop=", last?.stopReason);
					}
					this.#reraised = undefined;
				} catch (e) {
					this.#reraised = undefined;
					this.onDebug?.("advisor prompt threw", String(e));
					if (this.#epoch !== epoch) continue;
					failed = true;
				}
				if (failed) {
					this.#failures++;
					if (this.#failures >= 3) {
						this.#failures = 0;
						this.#lastOutcome = "failed";
					} else {
						this.#pending.unshift(...batch);
						this.#backlog += turns;
						await new Promise((r) => setTimeout(r, this.retryDelayMs));
					}
				}
				try {
					this.hooks?.onReviewComplete?.(failed ? "failed" : "ok");
				} catch (e) {
					this.onDebug?.("advisor onReviewComplete threw", String(e));
				}
			}
		} finally {
			this.#busy = false;
			if (this.idle) {
				this.#notifySettled();
				try {
					this.onSettled?.(this.#lastOutcome === "failed" ? "failed" : "ok");
				} catch (e) {
					this.onDebug?.("advisor onSettled callback threw", String(e));
				}
			}
		}
	}
}
