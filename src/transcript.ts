import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

function textOf(content: Array<{ type: string; text?: string }>): string {
	return content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("");
}

function renderArgValue(v: unknown, indent: string, depth: number): string {
	if (typeof v === "string") return v.includes("\n") ? `\n${v}` : ` ${v}`;
	if (v === null || typeof v !== "object") return ` ${String(v)}`;
	if (depth >= 8) return " […]";
	const childIndent = `${indent}  `;
	if (Array.isArray(v)) {
		if (v.length === 0) return " []";
		return v.map((e, i) => `\n${indent}- [${i}]${renderArgValue(e, childIndent, depth + 1)}`).join("");
	}
	const entries = Object.entries(v as Record<string, unknown>);
	if (entries.length === 0) return " {}";
	return entries.map(([k, val]) => `\n${indent}${k}:${renderArgValue(val, childIndent, depth + 1)}`).join("");
}

function renderToolArgs(args: Record<string, unknown> | undefined): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args);
	if (entries.length === 0) return "";
	return entries.map(([k, v]) => `${k}:${renderArgValue(v, "  ", 0)}`).join("\n");
}

export function formatTurnDelta(opts: {
	userPrompt?: string;
	assistant?: AssistantMessage;
	toolResults?: ToolResultMessage[];
}): string {
	const parts: string[] = [];
	if (opts.userPrompt?.trim()) parts.push(`#### User\n\n${opts.userPrompt.trim()}`);

	const diffByCallId = new Map<string, string>();
	for (const tr of opts.toolResults ?? []) {
		const id = (tr as { toolCallId?: string }).toolCallId;
		const d = (tr as { details?: { diff?: unknown } }).details?.diff;
		if (id && !tr.isError && typeof d === "string" && d.trim()) diffByCallId.set(id, d);
	}

	const a = opts.assistant;
	if (a) {
		const sub: string[] = [];
		for (const c of a.content) {
			if (c.type === "thinking" && c.thinking?.trim()) {
				sub.push(`<thinking>\n${c.thinking.trim()}\n</thinking>`);
			} else if (c.type === "text" && c.text?.trim()) {
				sub.push(c.text.trim());
			} else if (c.type === "toolCall") {
				const edits = (c.arguments as { edits?: unknown[] } | undefined)?.edits;
				const hasDiff = diffByCallId.has((c as { id?: string }).id ?? "");
				if (hasDiff && Array.isArray(edits)) {
					const p = (c.arguments as { path?: string }).path ?? "?";
					sub.push(`→ tool \`${c.name}\`(${p}) — ${edits.length} block(s); diff in tool result`);
				} else {
					const argsText = renderToolArgs(c.arguments as Record<string, unknown> | undefined);
					sub.push(argsText ? `→ tool \`${c.name}\`:\n${argsText}` : `→ tool \`${c.name}\``);
				}
			}
		}
		if (sub.length) parts.push(`#### Assistant\n\n${sub.join("\n\n")}`);
	}

	for (const tr of opts.toolResults ?? []) {
		const diff = (tr as { details?: { diff?: unknown } }).details?.diff;
		const body =
			!tr.isError && typeof diff === "string" && diff.trim()
				? diff
				: textOf(tr.content as Array<{ type: string; text?: string }>);
		parts.push(`#### Tool result: \`${tr.toolName}\`${tr.isError ? " (error)" : ""}\n\n${body || "(no text output)"}`);
	}
	return parts.join("\n\n");
}

export function buildReviewMessages(preamble: string, batch: string[]): UserMessage[] {
	const now = Date.now();
	const messages: UserMessage[] = [
		{ role: "user", content: [{ type: "text", text: `### Session update\n\n${preamble}`.trimEnd() }], timestamp: now },
	];
	for (const delta of batch) {
		if (delta.trim()) messages.push({ role: "user", content: [{ type: "text", text: delta }], timestamp: now });
	}
	return messages;
}

export type MonitorKind =
	| "user"
	| "assistant"
	| "thinking"
	| "tool"
	| "tool-result"
	| "marker"
	| "advice"
	| "error"
	| "status";

export interface MonitorEvent {
	id: string;
	ts: number;
	kind: MonitorKind;
	title: string;
	body: string;
	streaming?: boolean;
	persisted?: boolean;
}

const LIVE_CACHE_LIMIT = 2000;

export class MonitorStore {
	#events: MonitorEvent[] = [];
	#listeners = new Set<() => void>();
	#seq = 0;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const l of [...this.#listeners]) l();
	}

	snapshot(): MonitorEvent[] {
		return this.#events.slice();
	}

	clear(): void {
		this.#events = [];
		this.#emit();
	}

	replace(events: MonitorEvent[]): void {
		this.#events = events.slice(-LIVE_CACHE_LIMIT);
		this.#emit();
	}

	append(event: Omit<MonitorEvent, "id" | "ts"> & { id?: string; ts?: number }): MonitorEvent {
		const full: MonitorEvent = {
			id: event.id ?? `m${++this.#seq}`,
			ts: event.ts ?? Date.now(),
			kind: event.kind,
			title: event.title,
			body: event.body,
			streaming: event.streaming,
			persisted: event.persisted,
		};
		this.#events.push(full);
		if (this.#events.length > LIVE_CACHE_LIMIT) this.#events.splice(0, this.#events.length - LIVE_CACHE_LIMIT);
		this.#emit();
		return full;
	}

	update(id: string, patch: Partial<Pick<MonitorEvent, "title" | "body" | "streaming" | "kind">>): void {
		let idx = -1;
		for (let i = this.#events.length - 1; i >= 0; i--) {
			if (this.#events[i]!.id === id) {
				idx = i;
				break;
			}
		}
		if (idx < 0) return;
		this.#events[idx] = { ...this.#events[idx]!, ...patch };
		this.#emit();
	}

	marker(title: string, body = ""): MonitorEvent {
		return this.append({ kind: "marker", title, body });
	}
}
