export const ADVISORY_TYPE = "advisory";
export const STATUS_KEY = "q-advisor";

export const SESSION_CUSTOM = {
	observed: "pi-xt-advisors.observed",
	checkpoint: "pi-xt-advisors.checkpoint",
	advice: "pi-xt-advisors.advice",
	contextReset: "pi-xt-advisors.context-reset",
	configRevision: "pi-xt-advisors.config-revision",
} as const;

export const HANDOFF_IN_PROGRESS_KEY = Symbol.for("pi-amplike-handoff-in-progress");
export const HANDOFF_SESSION_REPLACED_CHANNEL = "pi-amplike:handoff-session-replaced";

export const DEFAULT_ADVISOR_MODEL = "openrouter/z-ai/glm-5.2:low";
export const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
export const BUILTIN_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"powershell",
	"edit",
	"write",
] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const BLOCK_BASE_MS = 15_000;
export const BLOCK_CAP_MS = 120_000;
