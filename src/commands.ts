import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { AdvisorSeverity } from "./advice.ts";
import { parseAdvisorTestArgs } from "./advice.ts";
import { runAdvisorConfigurator, type ConfigHost } from "./ui/config.ts";
import { openAdvisorMonitor, type MonitorHost } from "./ui/monitor.ts";

export interface AdvisorCommandHost extends ConfigHost {
	isReviewEnabled(): boolean;
	setReview(enabled: boolean, ctx: ExtensionCommandContext, scope: "user" | "project"): Promise<void>;
	statusText(ctx: ExtensionCommandContext): Promise<string>;
	monitorHost(ctx: ExtensionCommandContext): MonitorHost;
	injectTestAdvice(severity: AdvisorSeverity, note: string): void;
}

function parseCommand(args: string): { cmd: string; rest: string } {
	const trimmed = args.trim();
	const sp = trimmed.search(/\s/);
	if (sp < 0) return { cmd: trimmed.toLowerCase(), rest: "" };
	return { cmd: trimmed.slice(0, sp).toLowerCase(), rest: trimmed.slice(sp + 1).trim() };
}

export function registerAdvisorCommand(pi: ExtensionAPI, host: AdvisorCommandHost): void {
	pi.registerCommand("advisor", {
		description: "Advisor review, config, and live monitor. Usage: /advisor [on|off|status|config|monitor]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
			[
				{ value: "status", label: "status", description: "Show advisor status" },
				{ value: "on", label: "on", description: "Enable review" },
				{ value: "off", label: "off", description: "Disable review" },
				{ value: "config", label: "config", description: "Edit advisor settings" },
				{ value: "monitor", label: "monitor", description: "Live advisor transcript" },
			].filter((i) => i.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			const { cmd, rest } = parseCommand(args);

			if (cmd === "" || cmd === "status") {
				ctx.ui.notify(await host.statusText(ctx), "info");
				return;
			}
			if (cmd === "on" || cmd === "off") {
				const enabled = cmd === "on";
				const scope = rest === "project" ? "project" : "user";
				if (scope === "project" && !ctx.isProjectTrusted()) {
					ctx.ui.notify("Project settings are unavailable until the project is trusted", "warning");
					return;
				}
				await host.setReview(enabled, ctx, scope);
				return;
			}
			if (cmd === "config") {
				await runAdvisorConfigurator(ctx, host);
				return;
			}
			if (cmd === "monitor") {
				await openAdvisorMonitor(ctx, host.monitorHost(ctx), host.getConfig());
				return;
			}
			if (cmd === "test") {
				const parsed = parseAdvisorTestArgs(args);
				if (!parsed) {
					ctx.ui.notify("usage: /advisor test <nit|concern|blocker> <note>", "warning");
					return;
				}
				host.injectTestAdvice(parsed.severity, parsed.note);
				return;
			}
			ctx.ui.notify("usage: /advisor [on|off|status|config|monitor]", "warning");
		},
	});
}

