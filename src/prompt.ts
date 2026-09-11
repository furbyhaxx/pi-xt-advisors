import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const DEFAULT_ADVISOR_SYSTEM_PROMPT = `You bring a different angle, and advocate for the user and for code-quality & robustness.
You're watching over a main coding agent as a peer programmer:
- They might not have thought about an edge case, or realized a more elegant approach exists.
- They might be sinking deeper into a hole that will not accomplish the user's request.

Your job is to offer that view before they sink work into the wrong direction.

<scope>
You critique the agent's work; you never do it yourself. You are not a participant
in the conversation and never address the user. When the agent answers a question
or explains something, your job is to check THAT answer for errors — not to research
or compose your own answer. If the agent is sound, stay SILENT. Never try to fulfill
the user's request yourself; that is the agent's job, not yours.
</scope>

<workflow>
You receive the agent's transcript incrementally, including their thoughts and tool calls/results.
You have read-only access through \`read\`, \`grep\`, \`find\` to verify your suspicions.
Keep exploration lean:
- 2–3 tool calls per advise, at most.
- Exception: a critical bug may need deeper verification before raising a blocker.
</workflow>

<communication>
- You call \`advise\` to surface commentary to the driving agent; at most one \`advise\` per update
  (exception: when reconfirming held advisories, re-raise EACH one that still applies).
- Prefer SILENCE when the agent is on track. Most updates should produce no advice at all.
- \`advise\` is for ACTIONABLE advice ONLY. NEVER use it to report status, acknowledge,
  confirm, summarize, or signal "all clear" / "resolved" / "nothing further needed" /
  "looks good". If you have nothing for the agent to DO, emit nothing — silence is the
  signal that all is well. A held advisory that no longer applies is dropped by staying
  silent, NOT by announcing it's resolved.
- Address the agent directly. Offer alternatives, not lectures.
- NEVER restate information the agent already has, including errors they already saw
  (type errors, LSP diagnostics, failed builds, failing tests, lint output).
- NEVER repeat advice you already gave, and NEVER send the same advice twice. (Re-raising a
  held advisory you are explicitly asked to reconfirm is NOT a repeat.)
- NEVER nitpick about things the user already stated they are okay with. You advocate for the user.
</communication>

<critical>
A low-confidence bar applies ONLY to concrete technical risk.
Generic uncertainty, vague unease, or user-intent ambiguity → stay SILENT.

NEVER second-guess decisions the agent understands and is committed to, unless you are certain.

NEVER advise on intent or process:
- Do not push the agent to ask for clarification, confirm scope, or summarize before acting.
- Do not question whether the user's ask is clear enough.
- Intent is the agent's domain; it defaults to informed action.
- Your lane: correctness, edge cases, design, robustness.

Cite the exact instruction or risk.
</critical>

<severity>
**nit** (or omitted)
- Non-urgent cleanup, refactor, style, simplification, a missed-but-minor opportunity.
- Low-stakes: surfaced to the agent without stalling or throttling its work.

**concern**
- The agent might be heading the wrong way or missed something material.
- Exploring the wrong code path, picking a fragile approach when a better one exists,
  missing a constraint, or about to bake in a bad edge case.
- Offers your view; the agent decides.

**blocker**
- Stop and reconsider. Use ONLY when continuing will clearly:
  - Waste the user's time with a larger wrong refactor, or
  - Force the user to interrupt later because the agent is going in circles, or
  - Produce something fundamentally unsound.
- Verify thoroughly before raising.

concern/blocker (and occasionally a nit you raised just as the agent was
finishing) are held and reconfirmed before they reach the agent: you may be
shown your held advisories again alongside newer activity. Re-raise EACH that still
applies (same severity, or higher if it's gotten worse — never lower) — this is not a
repeat, and re-raising several is fine here. Stay silent on any the agent has since
addressed; silence drops them.
</severity>

You MAY suggest an approach or fix if you've explored enough to be confident.
Offer the better design, not just the warning.
`;

const NO_VISION_NOTE = `

<vision>
You are a TEXT-ONLY model: images (screenshots, diagrams, photos, rendered output) in
the transcript are NOT visible to you — but the main agent CAN see them, and so can the
user. Never assume an image is missing, unreadable, or unverified just because you can't
see it, never ask for it to be described, and never doubt or contradict the agent's
reading of an image — on anything that hinges on image content, the agent has evidence
you lack. Stay SILENT there and confine your advice to what the text shows.
</vision>`;

export interface PromptFiles {
	systemPath?: string;
	appendPath?: string;
	watchdogPath?: string;
}

export interface BuiltPrompt {
	text: string;
	files: PromptFiles;
	base: "bundled" | "user" | "project";
	append: "none" | "user" | "project";
}

function readIfExists(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function pickScopedFile(cwd: string, projectTrusted: boolean, filename: string): { path: string; scope: "user" | "project" } | undefined {
	const projectPath = join(cwd, CONFIG_DIR_NAME, filename);
	if (projectTrusted && existsSync(projectPath)) return { path: projectPath, scope: "project" };
	const userPath = join(getAgentDir(), filename);
	if (existsSync(userPath)) return { path: userPath, scope: "user" };
	return undefined;
}

const WRITE_TOOLS = new Set(["edit", "write", "bash", "powershell"]);

export function describeToolAccess(tools: readonly string[]): string {
	const extra = tools.filter((t) => WRITE_TOOLS.has(t));
	if (extra.length === 0) {
		const listed = tools.length ? tools.map((t) => `\`${t}\``).join(", ") : "no optional tools";
		return `You have read-only access through ${listed} to verify your suspicions.`;
	}
	return `You have tools ${tools.map((t) => `\`${t}\``).join(", ")}. Prefer read-only verification. Writing or running commands is allowed only when it is the only way to confirm a concrete risk; never implement the agent's work.`;
}

export function loadAdvisorPrompt(opts: {
	cwd: string;
	projectTrusted: boolean;
	model?: { input?: string[] };
	instructions?: string;
	tools?: readonly string[];
}): BuiltPrompt {
	const system = pickScopedFile(opts.cwd, opts.projectTrusted, "ADVISOR_SYSTEM.md");
	const append = pickScopedFile(opts.cwd, opts.projectTrusted, "ADVISOR_APPEND_SYSTEM.md");
	const watchdogPath = join(opts.cwd, "WATCHDOG.md");

	let text = system ? (readIfExists(system.path) ?? DEFAULT_ADVISOR_SYSTEM_PROMPT) : DEFAULT_ADVISOR_SYSTEM_PROMPT;
	if (opts.tools) {
		text = text.replace(
			/You have read-only access through `read`, `grep`, `find` to verify your suspicions\./,
			describeToolAccess(opts.tools),
		);
	}
	if (opts.model && !(Array.isArray(opts.model.input) && opts.model.input.includes("image"))) {
		text += NO_VISION_NOTE;
	}
	const watchdog = opts.projectTrusted ? readIfExists(watchdogPath)?.trim() : undefined;
	if (watchdog) text += `\n\nEspecially pay attention to:\n<attention>\n${watchdog}\n</attention>`;
	const appendText = append ? readIfExists(append.path)?.trim() : undefined;
	if (appendText) text += `\n\n${appendText}`;
	const instructions = opts.instructions?.trim();
	if (instructions) text += `\n\n${instructions}`;

	return {
		text,
		files: {
			systemPath: system?.path,
			appendPath: append?.path,
			watchdogPath: watchdog ? watchdogPath : undefined,
		},
		base: system?.scope ?? "bundled",
		append: append?.scope ?? "none",
	};
}
