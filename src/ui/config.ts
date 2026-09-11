import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import {
	buildSettingsPatch,
	draftFromScope,
	loadConfig,
	patchIsEmpty,
	projectSettingsPath,
	saveAdvisorSettings,
	userSettingsPath,
	type LoadedConfig,
	type ScopeDraft,
} from "../config.ts";
import { BUILTIN_TOOL_NAMES, THINKING_LEVELS } from "../constants.ts";
import { formatAdvisorModelSpec, parseAdvisorModelSpec } from "../model.ts";

export interface ConfigHost {
	getConfig(): LoadedConfig;
	applyConfig(next: LoadedConfig, ctx: ExtensionCommandContext): void;
}

type ConfigAction = "save" | "cancel" | "edit-model" | "edit-pct" | "edit-tools" | "edit-instructions";

function boolValue(inherit: boolean, value: boolean): string {
	return inherit ? "inherit" : value ? "on" : "off";
}

function formatTools(tools: string[]): string {
	return tools.length === 0 ? "(advise only)" : tools.join(", ");
}

async function pickModel(ctx: ExtensionCommandContext, current: string): Promise<string | undefined> {
	const registry = ctx.modelRegistry as ModelRegistry;
	const available = registry.getAvailable();
	const parsed = parseAdvisorModelSpec(current);
	const options = available.map((m) => `${m.provider}/${m.id}`);
	if (options.length === 0) {
		return ctx.ui.input("Advisor model (provider/model[:thinking])", current);
	}
	const picked = await ctx.ui.select("Advisor model", [...options.slice(0, 40), "Enter manually…"]);
	if (!picked) return undefined;
	if (picked === "Enter manually…") return ctx.ui.input("Advisor model (provider/model[:thinking])", current);
	const model = available.find((m) => `${m.provider}/${m.id}` === picked);
	if (!model?.reasoning) return picked;
	const level = await ctx.ui.select("Thinking level", [...THINKING_LEVELS]);
	if (!level) return formatAdvisorModelSpec(model, parsed?.thinkingLevel);
	return formatAdvisorModelSpec(model, level as (typeof THINKING_LEVELS)[number]);
}

async function editTools(ctx: ExtensionCommandContext, current: string[]): Promise<string[] | undefined> {
	const selected = new Set(current);
	const result = await ctx.ui.custom<string[] | undefined>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Advisor tools")), 1, 0));
		container.addChild(
			new Text(theme.fg("muted", "Omitted config uses read/grep/find/ls. Empty list = advise only. Unknown names stay unavailable."), 1, 0),
		);
		const items: SettingItem[] = BUILTIN_TOOL_NAMES.map((name) => ({
			id: name,
			label: name,
			currentValue: selected.has(name) ? "on" : "off",
			values: ["on", "off"],
			description: name === "bash" || name === "edit" || name === "write" || name === "powershell" ? "expands beyond read-only" : undefined,
		}));
		items.push(
			{ id: "save", label: "Done", currentValue: "", values: ["save"] },
			{ id: "cancel", label: "Cancel", currentValue: "", values: ["cancel"] },
		);
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 16),
			getSettingsListTheme(),
			(id, value) => {
				if (id === "save") {
					done([...selected]);
					return;
				}
				if (id === "cancel") {
					done(undefined);
					return;
				}
				if (value === "on") selected.add(id);
				else selected.delete(id);
				tui.requestRender();
			},
			() => done(undefined),
		);
		container.addChild(list);
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	return result;
}

export async function runAdvisorConfigurator(ctx: ExtensionCommandContext, host: ConfigHost): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/advisor config requires TUI mode", "error");
		return;
	}

	const trusted = ctx.isProjectTrusted();
	const userPath = userSettingsPath();
	const projectPath = projectSettingsPath(ctx.cwd);
	const options = trusted ? [`User  ${userPath}`, `Project  ${projectPath}`] : [`User  ${userPath}`];
	const picked = await ctx.ui.select("Save advisor settings to which scope?", options);
	if (!picked) return;

	const scope: "user" | "project" = picked.startsWith("Project") ? "project" : "user";
	if (scope === "project" && !trusted) {
		ctx.ui.notify("Project settings are unavailable until the project is trusted", "warning");
		return;
	}

	let loaded = loadConfig(ctx.cwd, trusted);
	host.applyConfig(loaded, ctx);
	const initial = draftFromScope(loaded, scope);
	const draft: ScopeDraft = {
		inherit: { ...initial.inherit },
		model: initial.model,
		debug: initial.debug,
		compactPct: initial.compactPct,
		review: initial.review,
		tools: [...initial.tools],
		instructions: initial.instructions,
	};
	const dest = scope === "user" ? userPath : projectPath;

	while (true) {
		const action = await ctx.ui.custom<ConfigAction | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(`Advisor settings (${scope})`)), 1, 0));
			container.addChild(new Text(theme.fg("muted", dest), 1, 0));

			const items: SettingItem[] = [
				{
					id: "model",
					label: "model",
					currentValue: draft.inherit.model ? "inherit" : draft.model,
					values: ["inherit", "override"],
					description: `effective ${loaded.effective.model} (${loaded.provenance.model})`,
				},
				{
					id: "modelEdit",
					label: "edit model",
					currentValue: draft.inherit.model ? "(inherited)" : draft.model,
					values: draft.inherit.model ? undefined : ["edit"],
				},
				{
					id: "review",
					label: "review",
					currentValue: boolValue(draft.inherit.review, draft.review),
					values: ["on", "off", "inherit"],
					description: `effective ${loaded.effective.review ? "on" : "off"} (${loaded.provenance.review})`,
				},
				{
					id: "debug",
					label: "debug",
					currentValue: boolValue(draft.inherit.debug, draft.debug),
					values: ["on", "off", "inherit"],
				},
				{
					id: "compactPct",
					label: "compact.pct",
					currentValue: draft.inherit.compactPct ? "inherit" : String(draft.compactPct),
					values: ["inherit", "override"],
					description: `effective ${loaded.effective.compactPct} (${loaded.provenance.compactPct})`,
				},
				{
					id: "compactEdit",
					label: "edit compact.pct",
					currentValue: draft.inherit.compactPct ? "(inherited)" : String(draft.compactPct),
					values: draft.inherit.compactPct ? undefined : ["edit"],
				},
				{
					id: "toolsSource",
					label: "tools",
					currentValue: draft.inherit.tools ? "inherit" : "override",
					values: ["inherit", "override"],
					description: draft.inherit.tools
						? `inherited ${formatTools(loaded.effective.tools)}`
						: formatTools(draft.tools),
				},
				{
					id: "toolsEdit",
					label: "edit tools",
					currentValue: draft.inherit.tools ? "(inherited)" : formatTools(draft.tools),
					values: draft.inherit.tools ? undefined : ["edit"],
				},
				{
					id: "instructions",
					label: "instructions",
					currentValue: draft.inherit.instructions ? "inherit" : draft.instructions ? "override" : "(empty)",
					values: ["inherit", "override"],
				},
				{
					id: "instructionsEdit",
					label: "edit instructions",
					currentValue: draft.inherit.instructions ? "(inherited)" : draft.instructions.slice(0, 40) || "(empty)",
					values: draft.inherit.instructions ? undefined : ["edit"],
				},
				{ id: "save", label: "Save", currentValue: "", values: ["save"], description: `Write ${scope} overrides to ${dest}` },
				{ id: "cancel", label: "Cancel", currentValue: "", values: ["cancel"] },
			];

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 4, 18),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "model") {
						draft.inherit.model = newValue === "inherit";
						if (!draft.inherit.model && !draft.model) draft.model = loaded.effective.model;
					} else if (id === "modelEdit" && newValue === "edit") {
						done("edit-model");
						return;
					} else if (id === "review") {
						if (newValue === "inherit") draft.inherit.review = true;
						else {
							draft.inherit.review = false;
							draft.review = newValue === "on";
						}
					} else if (id === "debug") {
						if (newValue === "inherit") draft.inherit.debug = true;
						else {
							draft.inherit.debug = false;
							draft.debug = newValue === "on";
						}
					} else if (id === "compactPct") {
						draft.inherit.compactPct = newValue === "inherit";
					} else if (id === "compactEdit" && newValue === "edit") {
						done("edit-pct");
						return;
					} else if (id === "toolsSource") {
						if (newValue === "inherit") draft.inherit.tools = true;
						else {
							if (draft.inherit.tools) draft.tools = [...loaded.effective.tools];
							draft.inherit.tools = false;
						}
					} else if (id === "toolsEdit" && newValue === "edit") {
						done("edit-tools");
						return;
					} else if (id === "instructions") {
						draft.inherit.instructions = newValue === "inherit";
						if (!draft.inherit.instructions && draft.instructions === undefined) draft.instructions = loaded.effective.instructions;
					} else if (id === "instructionsEdit" && newValue === "edit") {
						done("edit-instructions");
						return;
					} else if (id === "save") {
						done("save");
						return;
					} else if (id === "cancel") {
						done("cancel");
						return;
					}
					tui.requestRender();
				},
				() => done("cancel"),
			);
			container.addChild(settingsList);
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		if (action === "edit-model") {
			const next = await pickModel(ctx, draft.model);
			if (next) {
				draft.model = next;
				draft.inherit.model = false;
			}
			continue;
		}
		if (action === "edit-pct") {
			const raw = await ctx.ui.input("compact.pct (50-95)", String(draft.compactPct));
			if (raw !== undefined) {
				const n = Number(raw);
				if (!Number.isFinite(n) || n < 50 || n > 95) ctx.ui.notify("compact.pct must be 50–95", "error");
				else {
					draft.compactPct = n;
					draft.inherit.compactPct = false;
				}
			}
			continue;
		}
		if (action === "edit-tools") {
			const next = await editTools(ctx, draft.tools);
			if (next) {
				draft.tools = next;
				draft.inherit.tools = false;
			}
			continue;
		}
		if (action === "edit-instructions") {
			const text = await ctx.ui.editor("Advisor instructions (appended to system prompt)", draft.instructions);
			if (text !== undefined) {
				draft.instructions = text;
				draft.inherit.instructions = false;
			}
			continue;
		}
		if (action !== "save") return;

		const patch = buildSettingsPatch(initial, draft);
		if (patchIsEmpty(patch)) {
			ctx.ui.notify("No changes to save", "info");
			return;
		}
		await ctx.waitForIdle();
		const result = saveAdvisorSettings(scope, ctx.cwd, patch);
		if (!result.ok) {
			ctx.ui.notify(result.error, "error");
			return;
		}
		const next = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		host.applyConfig(next, ctx);
		const masked: string[] = [];
		if (scope === "user") {
			if (patch.model != null && next.provenance.model === "project") masked.push("model");
			if (patch.debug != null && next.provenance.debug === "project") masked.push("debug");
			if (patch.review != null && next.provenance.review === "project") masked.push("review");
			if (patch.compactPct != null && next.provenance.compactPct === "project") masked.push("compact.pct");
			if (patch.tools != null && next.provenance.tools === "project") masked.push("tools");
			if (patch.instructions != null && next.provenance.instructions === "project") masked.push("instructions");
		}
		let msg = `Saved ${scope} advisor settings to ${dest}`;
		if (masked.length > 0) msg += `. Project still overrides: ${masked.join(", ")}`;
		ctx.ui.notify(msg, "info");
		return;
	}
}
