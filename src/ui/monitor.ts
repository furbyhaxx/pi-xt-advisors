import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { LoadedConfig } from "../config.ts";
import type { RuntimeUsage } from "../runtime.ts";
import type { MonitorEvent, MonitorStore } from "../transcript.ts";

export interface MonitorHost {
	store: MonitorStore;
	sessionPath?: string;
	ephemeral: boolean;
	review: boolean;
	modelLabel?: string;
	thinkingLevel?: string;
	stateLabel: string;
	usage?: RuntimeUsage;
	backlog: number;
	unavailable?: string;
}

function formatEvent(event: MonitorEvent, theme: Theme, width: number): string[] {
	const color =
		event.kind === "error"
			? "error"
			: event.kind === "advice"
				? "warning"
				: event.kind === "marker" || event.kind === "status"
					? "dim"
					: event.kind === "thinking"
						? "muted"
						: event.kind === "tool" || event.kind === "tool-result"
							? "toolTitle"
							: "text";
	const stream = event.streaming ? theme.fg("accent", " …") : "";
	const header = theme.fg(color, `▸ ${event.title}`) + stream;
	const lines = [truncateToWidth(header, width)];
	if (event.body.trim()) {
		for (const raw of event.body.split("\n")) {
			for (const wrapped of wrapTextWithAnsi(theme.fg("muted", raw), width)) lines.push(wrapped);
		}
	}
	return lines;
}

class MonitorView implements Component {
	#scroll = 0;
	#follow = true;
	#unsubscribe?: () => void;
	#disposed = false;
	#timer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly host: MonitorHost,
		private readonly done: (value: undefined) => void,
	) {
		this.#unsubscribe = host.store.subscribe(() => this.#schedule());
	}

	#schedule(): void {
		if (this.#disposed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.tui.requestRender();
		}, 50);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
			this.done(undefined);
			return;
		}
		const rows = Math.max(8, this.tui.terminal.rows - 2);
		const body = Math.max(4, Math.floor(rows * 0.95) - 6);
		if (matchesKey(data, Key.up)) {
			this.#follow = false;
			this.#scroll = Math.max(0, this.#scroll - 1);
		} else if (matchesKey(data, Key.down)) {
			this.#scroll++;
		} else if (matchesKey(data, Key.pageUp) || data === "b") {
			this.#follow = false;
			this.#scroll = Math.max(0, this.#scroll - body);
		} else if (matchesKey(data, Key.pageDown) || data === "f" || data === " ") {
			this.#scroll += body;
		} else if (matchesKey(data, Key.home)) {
			this.#follow = false;
			this.#scroll = 0;
		} else if (matchesKey(data, Key.end)) {
			this.#follow = true;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(12, Math.floor(this.tui.terminal.rows * 0.95));
		const inner = Math.max(20, width);
		const th = this.theme;
		const header = [
			th.fg("accent", th.bold(" advisor monitor ")),
			th.fg("muted", this.host.modelLabel ? `${this.host.modelLabel}${this.host.thinkingLevel ? `:${this.host.thinkingLevel}` : ""}` : "no model"),
			th.fg("dim", ` · ${this.host.stateLabel}`),
			this.host.review ? "" : th.fg("warning", " · review off"),
		].join("");

		const usage = this.host.usage;
		const meta = [
			this.host.ephemeral ? "ephemeral" : this.host.sessionPath ?? "(no session file)",
			usage ? `ctx ${usage.contextPercent ?? "?"}% · $${usage.cost.toFixed(4)} · backlog ${this.host.backlog}` : `backlog ${this.host.backlog}`,
		].join(" · ");

		const events = this.host.store.snapshot();
		const bodyLines: string[] = [];
		if (this.host.unavailable) {
			bodyLines.push(th.fg("error", this.host.unavailable));
		} else if (events.length === 0) {
			bodyLines.push(th.fg("dim", "No advisor transcript yet."));
		} else {
			for (const event of events) bodyLines.push(...formatEvent(event, th, inner));
		}

		const headerLines = 3;
		const footerLines = 2;
		const bodyHeight = Math.max(4, height - headerLines - footerLines);
		const maxScroll = Math.max(0, bodyLines.length - bodyHeight);
		if (this.#follow) this.#scroll = maxScroll;
		this.#scroll = Math.min(maxScroll, Math.max(0, this.#scroll));
		if (this.#scroll < maxScroll) this.#follow = false;
		const slice = bodyLines.slice(this.#scroll, this.#scroll + bodyHeight);
		while (slice.length < bodyHeight) slice.push("");

		const footer = th.fg("dim", "↑↓/PgUp/PgDn scroll · End follow · q/esc close (does not stop the advisor)");
		return [
			truncateToWidth(header, inner),
			truncateToWidth(th.fg("muted", meta), inner),
			th.fg("dim", "─".repeat(Math.min(inner, 80))),
			...slice.map((l) => truncateToWidth(l, inner)),
			th.fg("dim", "─".repeat(Math.min(inner, 80))),
			truncateToWidth(footer, inner),
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#unsubscribe?.();
	}
}

export async function openAdvisorMonitor(ctx: ExtensionCommandContext, host: MonitorHost, config: LoadedConfig): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			[
				`advisor monitor (${host.ephemeral ? "ephemeral" : host.sessionPath ?? "no file"})`,
				`review ${config.effective.review ? "on" : "off"} · ${host.stateLabel}`,
				host.unavailable ?? `${host.store.snapshot().length} events`,
			].join("\n"),
			"info",
		);
		return;
	}

	await ctx.ui.custom<undefined>(
		(tui, theme, _kb, done) => new MonitorView(tui, theme, host, done),
		{
			overlay: true,
			overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center" },
		},
	);
}
