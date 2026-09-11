import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AdvisorNote } from "./advice.ts";
import { SESSION_CUSTOM } from "./constants.ts";
import type { MonitorEvent } from "./transcript.ts";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as {
	lockSync: (file: string, opts?: { realpath?: boolean }) => () => void;
};

export function advisorSessionPath(observedSessionFile: string): string {
	return join(dirname(observedSessionFile), "advisor", basename(observedSessionFile));
}

export interface ObservedSessionRef {
	id?: string;
	file?: string;
	cwd: string;
}

export interface AdvisorCheckpoint {
	version: 1;
	kind:
		| "review-start"
		| "review-complete"
		| "context-reset"
		| "primary-compact"
		| "primary-tree"
		| "config-revision"
		| "shutdown";
	observedSessionId?: string;
	observedSessionFile?: string;
	observedLeafId?: string | null;
	reviewedEntryIds?: string[];
	heldAdvice?: AdvisorNote[];
	delivered?: Array<[string, number]>;
	reviewOutcome?: "ok" | "failed" | "interrupted";
	origin?: string;
}

export interface RestoredAdvisorState {
	messages: AgentMessage[];
	heldAdvice: AdvisorNote[];
	delivered: Array<[string, number]>;
	reviewedEntryIds: string[];
	observedLeafId?: string | null;
	lifetime: { input: number; output: number; cost: number };
	interrupted: boolean;
}

export class PersistenceError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = "PersistenceError";
		if (options?.cause) (this as Error & { cause?: unknown }).cause = options.cause;
	}
}

function lockWithRetry(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: string }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				/* spin */
			}
		}
	}
	throw lastError ?? new Error("Failed to acquire advisor session lock");
}

function dropIncomplete(messages: AgentMessage[]): { messages: AgentMessage[]; interrupted: boolean } {
	if (messages.length === 0) return { messages, interrupted: false };
	const last = messages[messages.length - 1]!;
	if (last.role === "assistant") {
		const stop = (last as AssistantMessage).stopReason;
		if (stop === "error" || stop === "aborted" || stop === "length") {
			return { messages: messages.slice(0, -1), interrupted: true };
		}
		if (stop === "toolUse") {
			return { messages: messages.slice(0, -1), interrupted: true };
		}
	}
	return { messages, interrupted: false };
}

function lifetimeFrom(messages: AgentMessage[]): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const m of messages) {
		if (m.role === "assistant" && (m as AssistantMessage).usage) {
			const u = (m as AssistantMessage).usage;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cost += u.cost?.total ?? 0;
		}
	}
	return { input, output, cost };
}

export class AdvisorSession {
	#sm: SessionManager;
	#path: string | undefined;
	#release: (() => void) | undefined;
	#writeQueue: Promise<void> = Promise.resolve();
	#failed = false;
	onError?: (error: PersistenceError) => void;

	private constructor(sm: SessionManager, path: string | undefined, release?: () => void) {
		this.#sm = sm;
		this.#path = path;
		this.#release = release;
	}

	get path(): string | undefined {
		return this.#path;
	}

	get persisted(): boolean {
		return !!this.#path;
	}

	get failed(): boolean {
		return this.#failed;
	}

	static open(observed: ObservedSessionRef): AdvisorSession {
		if (!observed.file) {
			return new AdvisorSession(SessionManager.inMemory(observed.cwd), undefined);
		}
		const path = advisorSessionPath(observed.file);
		mkdirSync(dirname(path), { recursive: true });
		if (!existsSync(path)) {
			const header = {
				type: "session",
				version: 3,
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				cwd: observed.cwd,
			};
			writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
		}
		const release = lockWithRetry(path);
		try {
			const sm = SessionManager.open(path, dirname(path), observed.cwd);
			const session = new AdvisorSession(sm, path, release);
			session.#ensureObserved(observed);
			return session;
		} catch (err) {
			try {
				release();
			} catch {}
			throw new PersistenceError(`failed to open advisor session ${path}`, { cause: err });
		}
	}

	#ensureObserved(observed: ObservedSessionRef): void {
		const existing = this.#sm.getEntries().find((e) => e.type === "custom" && e.customType === SESSION_CUSTOM.observed);
		if (existing) return;
		this.#sm.appendCustomEntry(SESSION_CUSTOM.observed, {
			version: 1,
			observedSessionId: observed.id,
			observedSessionFile: observed.file,
		});
	}

	#enqueue(fn: () => void): void {
		if (this.#failed) throw new PersistenceError("advisor session persistence already failed");
		this.#writeQueue = this.#writeQueue
			.then(() => {
				fn();
			})
			.catch((err) => {
				this.#failed = true;
				const wrapped = err instanceof PersistenceError ? err : new PersistenceError(String(err), { cause: err });
				this.onError?.(wrapped);
				throw wrapped;
			});
	}

	appendMessage(message: AgentMessage): void {
		this.#enqueue(() => {
			this.#sm.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
		});
	}

	appendAdvice(action: "held" | "reconfirmed" | "dropped" | "delivered", note: AdvisorNote, id: string): void {
		this.#enqueue(() => {
			this.#sm.appendCustomEntry(SESSION_CUSTOM.advice, {
				version: 1,
				id,
				action,
				note: note.note,
				severity: note.severity,
			});
		});
	}

	checkpoint(data: AdvisorCheckpoint): void {
		this.#enqueue(() => {
			this.#sm.appendCustomEntry(SESSION_CUSTOM.checkpoint, data);
		});
	}

	contextReset(reason: string): void {
		this.#enqueue(() => {
			this.#sm.appendCustomEntry(SESSION_CUSTOM.contextReset, { version: 1, reason });
		});
	}

	async flush(): Promise<void> {
		await this.#writeQueue;
	}

	restore(currentObservedLeafId?: string | null, currentBranchIds?: Set<string>): RestoredAdvisorState {
		const branch = this.#sm.getBranch();
		let start = 0;
		let heldAdvice: AdvisorNote[] = [];
		let delivered: Array<[string, number]> = [];
		let reviewedEntryIds: string[] = [];
		let observedLeafId: string | null | undefined;
		for (let i = 0; i < branch.length; i++) {
			const e = branch[i]!;
			if (e.type !== "custom") continue;
			if (e.customType === SESSION_CUSTOM.contextReset || e.customType === SESSION_CUSTOM.configRevision) {
				start = i + 1;
			}
			if (e.customType === SESSION_CUSTOM.checkpoint) {
				const data = e.data as AdvisorCheckpoint | undefined;
				if (!data) continue;
				if (currentBranchIds && data.observedLeafId && !currentBranchIds.has(data.observedLeafId)) continue;
				heldAdvice = data.heldAdvice?.map((n) => ({ ...n })) ?? heldAdvice;
				delivered = data.delivered ? data.delivered.map(([k, r]) => [k, r]) : delivered;
				reviewedEntryIds = data.reviewedEntryIds ?? reviewedEntryIds;
				observedLeafId = data.observedLeafId ?? observedLeafId;
			}
		}
		const messages: AgentMessage[] = [];
		for (const e of branch.slice(start)) {
			if (e.type === "message") messages.push(e.message);
		}
		const cleaned = dropIncomplete(messages);
		return {
			messages: cleaned.messages,
			heldAdvice,
			delivered,
			reviewedEntryIds,
			observedLeafId: currentObservedLeafId ?? observedLeafId,
			lifetime: lifetimeFrom(this.#sm.getEntries().flatMap((e) => (e.type === "message" ? [e.message] : []))),
			interrupted: cleaned.interrupted,
		};
	}

	historyEvents(): MonitorEvent[] {
		const events: MonitorEvent[] = [];
		for (const e of this.#sm.getEntries()) {
			if (e.type === "message") {
				const m = e.message;
				if (m.role === "user") {
					const text = Array.isArray(m.content)
						? m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
						: String(m.content);
					events.push({
						id: e.id,
						ts: Date.parse(e.timestamp) || Date.now(),
						kind: "user",
						title: "review input",
						body: text,
						persisted: true,
					});
				} else if (m.role === "assistant") {
					const parts = (m as AssistantMessage).content ?? [];
					const thinking = parts.filter((c) => c.type === "thinking").map((c) => c.thinking).join("\n");
					const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n");
					const tools = parts.filter((c) => c.type === "toolCall");
					if (thinking) {
						events.push({
							id: `${e.id}-think`,
							ts: Date.parse(e.timestamp) || Date.now(),
							kind: "thinking",
							title: "thinking",
							body: thinking,
							persisted: true,
						});
					}
					if (text || tools.length === 0) {
						events.push({
							id: e.id,
							ts: Date.parse(e.timestamp) || Date.now(),
							kind: "assistant",
							title: "advisor",
							body: text || "(no text)",
							persisted: true,
						});
					}
					for (const t of tools) {
						events.push({
							id: `${e.id}-${t.id}`,
							ts: Date.parse(e.timestamp) || Date.now(),
							kind: "tool",
							title: t.name,
							body: JSON.stringify(t.arguments ?? {}, null, 2),
							persisted: true,
						});
					}
				} else if (m.role === "toolResult") {
					const text = Array.isArray(m.content)
						? m.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
						: "";
					events.push({
						id: e.id,
						ts: Date.parse(e.timestamp) || Date.now(),
						kind: "tool-result",
						title: m.toolName + (m.isError ? " (error)" : ""),
						body: text,
						persisted: true,
					});
				}
			} else if (e.type === "custom") {
				if (e.customType === SESSION_CUSTOM.contextReset) {
					events.push({
						id: e.id,
						ts: Date.parse(e.timestamp) || Date.now(),
						kind: "marker",
						title: "context reset",
						body: String((e.data as { reason?: string } | undefined)?.reason ?? ""),
						persisted: true,
					});
				} else if (e.customType === SESSION_CUSTOM.advice) {
					const data = e.data as { action?: string; note?: string; severity?: string } | undefined;
					events.push({
						id: e.id,
						ts: Date.parse(e.timestamp) || Date.now(),
						kind: "advice",
						title: `${data?.action ?? "advice"} ${(data?.severity ?? "nit").toUpperCase()}`,
						body: data?.note ?? "",
						persisted: true,
					});
				} else if (e.customType === SESSION_CUSTOM.checkpoint) {
					const data = e.data as AdvisorCheckpoint | undefined;
					events.push({
						id: e.id,
						ts: Date.parse(e.timestamp) || Date.now(),
						kind: "status",
						title: data?.kind ?? "checkpoint",
						body: data?.reviewOutcome ?? "",
						persisted: true,
					});
				}
			}
		}
		return events;
	}

	close(): void {
		try {
			this.#release?.();
		} catch {}
		this.#release = undefined;
	}
}

export function deliveredAdviceIdsFromPrimary(entries: Iterable<{ type: string; customType?: string; data?: unknown; message?: { details?: { notes?: Array<{ id?: string; note?: string }> } } }>): Set<string> {
	const ids = new Set<string>();
	for (const e of entries) {
		if (e.type === "message" && e.message?.details?.notes) {
			for (const n of e.message.details.notes) {
				if (n.id) ids.add(n.id);
			}
		}
	}
	return ids;
}
