import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export type AdvisorSeverity = "nit" | "concern" | "blocker";
export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
}

const adviseSchema = Type.Object({
	note: Type.String({
		description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	}),
	severity: Type.Optional(
		Type.Union([Type.Literal("nit"), Type.Literal("concern"), Type.Literal("blocker")], {
			description: "How strongly to weigh this. Omit for a plain nit.",
		}),
	),
});

const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
export const rankOf = (s: AdvisorSeverity | undefined): number => SEVERITY_RANK[s ?? "nit"];
export const dedupeKey = (note: string): string => note.trim().replace(/\s+/g, " ");
export const isHighSeverity = (s: AdvisorSeverity | undefined): boolean => s === "concern" || s === "blocker";

export function nextBackoffMs(consecutive: number, baseMs = 15_000, capMs = 120_000): number {
	return Math.min(capMs, baseMs * 2 ** Math.max(0, consecutive));
}

export function isTerminalTurn(message: { content?: ReadonlyArray<{ type: string }> } | undefined): boolean {
	return !(message?.content ?? []).some((c) => c.type === "toolCall");
}

export interface TurnBlockRuntime {
	readonly hasHighPriority: boolean;
	takeAllAdvice(): AdvisorNote[];
	requeueAdvice(note: string, severity?: AdvisorSeverity): void;
	waitUntilSettled(timeoutMs: number, signal?: AbortSignal): Promise<"settled" | "timeout" | "aborted" | "failed">;
}

export async function runTurnBlock(opts: {
	terminal: boolean;
	runtime: TurnBlockRuntime;
	consecutiveBlocks: number;
	baseMs?: number;
	capMs?: number;
	signal?: AbortSignal;
	notify: (msg: string) => void;
	deliverHeld: (notes: AdvisorNote[], opts?: { terminal?: boolean }) => void;
}): Promise<number> {
	const { terminal, runtime } = opts;
	const baseMs = opts.baseMs ?? 15_000;
	const capMs = opts.capMs ?? 120_000;
	if (!terminal && !runtime.hasHighPriority) return 0;

	const timeoutMs = terminal ? capMs : nextBackoffMs(opts.consecutiveBlocks, baseMs, capMs);
	opts.notify(
		terminal
			? "advisor: catching up before the turn ends…"
			: `advisor: waiting up to ${Math.round(timeoutMs / 1000)}s to catch up…`,
	);

	const result = await runtime.waitUntilSettled(timeoutMs, opts.signal);
	if (result === "aborted") return opts.consecutiveBlocks;
	if (result === "settled") {
		const held = runtime.takeAllAdvice();
		if (held.length) opts.deliverHeld(held, { terminal });
		return 0;
	}
	if (terminal) {
		const held = runtime.takeAllAdvice();
		const high = held.filter((n) => isHighSeverity(n.severity));
		for (const n of held) if (!isHighSeverity(n.severity)) runtime.requeueAdvice(n.note, n.severity);
		if (high.length) {
			opts.deliverHeld(high, { terminal: true });
			opts.notify("advisor didn't reconfirm in time; delivering held advice anyway");
		}
		return 0;
	}
	return opts.consecutiveBlocks + 1;
}

export function formatReconfirmPreamble(held: readonly AdvisorNote[]): string {
	if (!held.length) return "";
	const items = held.map((n) => `- [${(n.severity ?? "nit").toUpperCase()}] ${n.note}`).join("\n");
	return [
		"### Held advisories — reconfirm",
		"",
		"You raised these on an earlier step; they were held pending reconfirmation, because by now the agent may have already addressed them. Re-check each against the latest activity below.",
		"For every item that STILL applies, call `advise` again — same severity, or higher if it's gotten worse; never lower it. Say nothing for the rest — silence drops them. Do NOT call `advise` to announce that an item is resolved or that all are cleared; just stay silent.",
		"",
		items,
		"",
		"---",
		"",
	].join("\n");
}

export function parseAdvisorTestArgs(args: string): { severity: AdvisorSeverity; note: string } | null {
	const m = args.trim().match(/^test\s+(nit|concern|blocker)\s+([\s\S]+)$/i);
	if (!m) return null;
	return { severity: m[1]!.toLowerCase() as AdvisorSeverity, note: m[2]!.trim() };
}

export class AdviseTool {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description =
		"Send one concrete, ACTIONABLE piece of advice to the agent you are watching. Use sparingly; stay silent when nothing matters. Call it to head off likely-wrong or materially wasteful work. NEVER call it to report status, acknowledge, confirm, summarize, or signal that all is well / resolved / nothing-further-needed — in those cases emit nothing.";
	readonly parameters = adviseSchema as typeof adviseSchema;
	#delivered = new Map<string, number>();

	constructor(private readonly onAdvice: (note: string, severity?: AdvisorSeverity) => boolean) {}

	resetDelivered(): void {
		this.#delivered.clear();
	}

	snapshotDelivered(): Array<[string, number]> {
		return [...this.#delivered.entries()];
	}

	restoreDelivered(entries: Iterable<[string, number]>): void {
		this.#delivered = new Map(entries);
	}

	markDelivered(note: string, severity?: AdvisorSeverity): void {
		this.#delivered.set(dedupeKey(note), rankOf(severity));
	}

	async execute(_id: string, args: { note: string; severity?: AdvisorSeverity }): Promise<AgentToolResult<unknown>> {
		const key = dedupeKey(args.note);
		const rank = rankOf(args.severity);
		const prev = this.#delivered.get(key) ?? 0;
		if (rank <= prev) {
			return { content: [{ type: "text", text: "Duplicate advice ignored." }], details: { ...args, dropped: true } };
		}
		const delivered = this.onAdvice(args.note, args.severity);
		if (!delivered) {
			return {
				content: [{ type: "text", text: "Queued for boundary delivery (or dropped as stale)." }],
				details: { ...args, held: true },
			};
		}
		this.#delivered.set(key, rank);
		return { content: [{ type: "text", text: "Recorded." }], details: { ...args } };
	}
}

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";
const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatAdvisoryContent(
	notes: readonly AdvisorNote[],
	opts?: { stale?: boolean; finalAnswer?: boolean },
): string {
	const context = opts?.stale ? ` context="raised about an earlier step"` : "";
	const body = notes
		.map((n) => {
			const sev = n.severity ? ` severity="${n.severity}"` : "";
			return `<advisory${sev}${context} guidance="${ADVISOR_GUIDANCE}">\n${escapeXml(n.note)}\n</advisory>`;
		})
		.join("\n");
	if (!opts?.finalAnswer) return body;
	return `${body}\n\nYou had already returned a final answer to the user this turn. If you act on the advice above, respond with a new, self-contained final answer that fully stands on its own — do NOT write a terse follow-up that assumes the user read your previous message. The user should be able to read your new reply alone and get the complete answer.`;
}

export type PrimaryTurnState = "running" | "ended-terminal" | "ended-nonterminal";

export function newAdviceId(): string {
	return `adv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
