import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ADVISOR_MODEL, DEFAULT_TOOLS } from "./constants.ts";

const require = createRequire(import.meta.url);
const lockfile = require("proper-lockfile") as {
	lockSync: (file: string, opts?: { realpath?: boolean }) => () => void;
};

export type Provenance = "default" | "user" | "project";
export type ConfigKey = "model" | "debug" | "compactPct" | "review" | "tools" | "instructions";

export interface AdvisorConfig {
	model: string;
	debug: boolean;
	compactPct: number;
	review: boolean;
	tools: string[];
	instructions: string;
}

export const DEFAULT_CONFIG: AdvisorConfig = {
	model: DEFAULT_ADVISOR_MODEL,
	debug: false,
	compactPct: 80,
	review: true,
	tools: [...DEFAULT_TOOLS],
	instructions: "",
};

export const CONFIG_KEYS: ConfigKey[] = ["model", "debug", "compactPct", "review", "tools", "instructions"];

export interface LoadedConfig {
	effective: AdvisorConfig;
	user: Partial<AdvisorConfig>;
	project: Partial<AdvisorConfig>;
	provenance: Record<ConfigKey, Provenance>;
	diagnostics: string[];
	userPath: string;
	projectPath: string;
}

export type AdvisorPatch = {
	model?: string | null;
	debug?: boolean | null;
	compactPct?: number | null;
	review?: boolean | null;
	tools?: string[] | null;
	instructions?: string | null;
};

export function userSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function stripBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function toolsEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function parseAdvisorObject(
	raw: unknown,
	label: string,
): { value: Partial<AdvisorConfig>; diagnostics: string[] } {
	if (raw === undefined) return { value: {}, diagnostics: [] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { value: {}, diagnostics: [`${label}: advisor must be a JSON object`] };
	}
	const o = raw as Record<string, unknown>;
	const value: Partial<AdvisorConfig> = {};
	const diagnostics: string[] = [];

	if ("model" in o) {
		if (typeof o.model === "string" && o.model.includes("/") && o.model.trim()) value.model = o.model.trim();
		else diagnostics.push(`${label}: model must be a string in provider/model[:thinking] form`);
	}
	if ("debug" in o) {
		if (typeof o.debug === "boolean") value.debug = o.debug;
		else diagnostics.push(`${label}: debug must be a boolean`);
	}
	if ("review" in o) {
		if (typeof o.review === "boolean") value.review = o.review;
		else diagnostics.push(`${label}: review must be a boolean`);
	}
	if ("instructions" in o) {
		if (typeof o.instructions === "string") value.instructions = o.instructions;
		else diagnostics.push(`${label}: instructions must be a string`);
	}
	if ("tools" in o) {
		if (Array.isArray(o.tools) && o.tools.every((t) => typeof t === "string")) {
			const seen = new Set<string>();
			value.tools = [];
			for (const t of o.tools) {
				const name = t.trim();
				if (!name || seen.has(name)) continue;
				seen.add(name);
				value.tools.push(name);
			}
		} else diagnostics.push(`${label}: tools must be an array of strings`);
	}
	if ("compact" in o) {
		if (!o.compact || typeof o.compact !== "object" || Array.isArray(o.compact)) {
			diagnostics.push(`${label}: compact must be an object`);
		} else if ("pct" in (o.compact as Record<string, unknown>)) {
			const pct = (o.compact as Record<string, unknown>).pct;
			if (typeof pct === "number" && Number.isFinite(pct) && pct >= 50 && pct <= 95) {
				value.compactPct = pct;
			} else diagnostics.push(`${label}: compact.pct must be a number between 50 and 95`);
		}
	}
	return { value, diagnostics };
}

function readSettingsFile(path: string, label: string): {
	settings: Record<string, unknown>;
	diagnostics: string[];
} {
	try {
		const raw = readFileSync(path, "utf-8");
		const v = JSON.parse(stripBom(raw));
		if (!v || typeof v !== "object" || Array.isArray(v)) {
			return { settings: {}, diagnostics: [`${label}: ${path} must be a JSON object`] };
		}
		return { settings: v as Record<string, unknown>, diagnostics: [] };
	} catch (err) {
		if ((err as { code?: string } | null)?.code === "ENOENT") return { settings: {}, diagnostics: [] };
		return { settings: {}, diagnostics: [`${label}: ${path}: ${err}`] };
	}
}

function mergeScopes(
	user: Partial<AdvisorConfig>,
	project: Partial<AdvisorConfig>,
): Pick<LoadedConfig, "effective" | "provenance"> {
	const provenance = {
		model: "default",
		debug: "default",
		compactPct: "default",
		review: "default",
		tools: "default",
		instructions: "default",
	} as Record<ConfigKey, Provenance>;
	const effective: AdvisorConfig = { ...DEFAULT_CONFIG, tools: [...DEFAULT_CONFIG.tools] };

	const apply = (src: Partial<AdvisorConfig>, scope: Provenance) => {
		if (src.model !== undefined) {
			effective.model = src.model;
			provenance.model = scope;
		}
		if (src.debug !== undefined) {
			effective.debug = src.debug;
			provenance.debug = scope;
		}
		if (src.compactPct !== undefined) {
			effective.compactPct = src.compactPct;
			provenance.compactPct = scope;
		}
		if (src.review !== undefined) {
			effective.review = src.review;
			provenance.review = scope;
		}
		if (src.tools !== undefined) {
			effective.tools = [...src.tools];
			provenance.tools = scope;
		}
		if (src.instructions !== undefined) {
			effective.instructions = src.instructions;
			provenance.instructions = scope;
		}
	};
	apply(user, "user");
	apply(project, "project");
	return { effective, provenance };
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadedConfig {
	const userPath = userSettingsPath();
	const projectPath = projectSettingsPath(cwd);
	const diagnostics: string[] = [];

	const g = readSettingsFile(userPath, "user");
	diagnostics.push(...g.diagnostics);
	const userParsed = parseAdvisorObject(g.settings.advisor, "user");
	diagnostics.push(...userParsed.diagnostics);

	let projectParsed: { value: Partial<AdvisorConfig>; diagnostics: string[] } = { value: {}, diagnostics: [] };
	if (projectTrusted) {
		const p = readSettingsFile(projectPath, "project");
		diagnostics.push(...p.diagnostics);
		projectParsed = parseAdvisorObject(p.settings.advisor, "project");
		diagnostics.push(...projectParsed.diagnostics);
	}

	const { effective, provenance } = mergeScopes(userParsed.value, projectParsed.value);
	for (const d of diagnostics) console.error(`pi-xt-advisors: ${d}`);
	return {
		effective,
		user: userParsed.value,
		project: projectParsed.value,
		provenance,
		diagnostics,
		userPath,
		projectPath,
	};
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
	throw lastError ?? new Error("Failed to acquire settings lock");
}

function withSettingsLock(path: string, fn: (current: string | undefined) => string | undefined): void {
	const dir = dirname(path);
	let release: (() => void) | undefined;
	try {
		const fileExists = existsSync(path);
		if (fileExists) release = lockWithRetry(path);
		const current = fileExists ? readFileSync(path, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) return;
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		if (!release) {
			if (!existsSync(path)) writeFileSync(path, "{}\n", "utf-8");
			release = lockWithRetry(path);
		}
		writeFileSync(path, next, "utf-8");
	} finally {
		try {
			release?.();
		} catch {
			/* ignore unlock errors */
		}
	}
}

export function saveAdvisorSettings(
	scope: "user" | "project",
	cwd: string,
	patch: AdvisorPatch,
): { ok: true } | { ok: false; error: string } {
	const path = scope === "user" ? userSettingsPath() : projectSettingsPath(cwd);
	try {
		let error: string | undefined;
		withSettingsLock(path, (current) => {
			let settings: Record<string, unknown>;
			if (current === undefined || current.trim() === "") {
				settings = {};
			} else {
				try {
					const v = JSON.parse(stripBom(current));
					if (!v || typeof v !== "object" || Array.isArray(v)) {
						error = `${path} must be a JSON object; refusing to overwrite it`;
						return undefined;
					}
					settings = v as Record<string, unknown>;
				} catch (err) {
					error = `${path} is not valid JSON; refusing to overwrite it (${err})`;
					return undefined;
				}
			}

			const existing = settings.advisor;
			if (existing !== undefined && existing !== null && (typeof existing !== "object" || Array.isArray(existing))) {
				error = `${path}: "advisor" must be a JSON object; refusing to overwrite it`;
				return undefined;
			}

			const advisor: Record<string, unknown> =
				existing && typeof existing === "object" && !Array.isArray(existing)
					? { ...(existing as Record<string, unknown>) }
					: {};

			const applyLeaf = (key: "model" | "debug" | "review" | "instructions" | "tools", value: unknown) => {
				if (value === null) delete advisor[key];
				else if (value !== undefined) advisor[key] = value;
			};
			applyLeaf("model", patch.model);
			applyLeaf("debug", patch.debug);
			applyLeaf("review", patch.review);
			applyLeaf("instructions", patch.instructions);
			applyLeaf("tools", patch.tools);

			if (patch.compactPct === null) {
				if (advisor.compact && typeof advisor.compact === "object" && !Array.isArray(advisor.compact)) {
					const compact = { ...(advisor.compact as Record<string, unknown>) };
					delete compact.pct;
					if (Object.keys(compact).length === 0) delete advisor.compact;
					else advisor.compact = compact;
				}
			} else if (patch.compactPct !== undefined) {
				const compact =
					advisor.compact && typeof advisor.compact === "object" && !Array.isArray(advisor.compact)
						? { ...(advisor.compact as Record<string, unknown>) }
						: {};
				compact.pct = patch.compactPct;
				advisor.compact = compact;
			}

			if (Object.keys(advisor).length === 0) delete settings.advisor;
			else settings.advisor = advisor;

			return `${JSON.stringify(settings, null, 2)}\n`;
		});
		if (error) return { ok: false, error };
		return { ok: true };
	} catch (err) {
		return { ok: false, error: `failed to save ${path}: ${err}` };
	}
}

export interface ScopeDraft {
	inherit: Record<ConfigKey, boolean>;
	model: string;
	debug: boolean;
	compactPct: number;
	review: boolean;
	tools: string[];
	instructions: string;
}

export function draftFromScope(loaded: LoadedConfig, scope: "user" | "project"): ScopeDraft {
	const scoped = scope === "user" ? loaded.user : loaded.project;
	return {
		inherit: {
			model: scoped.model === undefined,
			debug: scoped.debug === undefined,
			compactPct: scoped.compactPct === undefined,
			review: scoped.review === undefined,
			tools: scoped.tools === undefined,
			instructions: scoped.instructions === undefined,
		},
		model: scoped.model ?? loaded.effective.model,
		debug: scoped.debug ?? loaded.effective.debug,
		compactPct: scoped.compactPct ?? loaded.effective.compactPct,
		review: scoped.review ?? loaded.effective.review,
		tools: [...(scoped.tools ?? loaded.effective.tools)],
		instructions: scoped.instructions ?? loaded.effective.instructions,
	};
}

export function buildSettingsPatch(initial: ScopeDraft, draft: ScopeDraft): AdvisorPatch {
	const patch: AdvisorPatch = {};
	const apply = <K extends Exclude<ConfigKey, "compactPct" | "tools">>(key: K, compare: (a: ScopeDraft[K], b: ScopeDraft[K]) => boolean = (a, b) => a === b) => {
		if (draft.inherit[key]) {
			if (!initial.inherit[key]) patch[key] = null;
			return;
		}
		if (initial.inherit[key] || !compare(initial[key], draft[key])) patch[key] = draft[key] as never;
	};
	apply("model");
	apply("debug");
	apply("review");
	apply("instructions");
	if (draft.inherit.compactPct) {
		if (!initial.inherit.compactPct) patch.compactPct = null;
	} else if (initial.inherit.compactPct || initial.compactPct !== draft.compactPct) {
		patch.compactPct = draft.compactPct;
	}
	if (draft.inherit.tools) {
		if (!initial.inherit.tools) patch.tools = null;
	} else if (initial.inherit.tools || !toolsEqual(initial.tools, draft.tools)) {
		patch.tools = [...draft.tools];
	}
	return patch;
}

export function patchIsEmpty(patch: AdvisorPatch): boolean {
	return (
		patch.model === undefined &&
		patch.debug === undefined &&
		patch.compactPct === undefined &&
		patch.review === undefined &&
		patch.tools === undefined &&
		patch.instructions === undefined
	);
}

export function identityConfigChanged(a: AdvisorConfig, b: AdvisorConfig): boolean {
	return a.model !== b.model || !toolsEqual(a.tools, b.tools) || a.instructions !== b.instructions;
}
