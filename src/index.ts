import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	AdviseTool,
	formatAdvisoryContent,
	isHighSeverity,
	isTerminalTurn,
	newAdviceId,
	runTurnBlock,
	type AdvisorNote,
	type AdvisorSeverity,
	type PrimaryTurnState,
} from "./advice.ts";
import { registerAdvisorCommand, type AdvisorCommandHost } from "./commands.ts";
import {
	identityConfigChanged,
	loadConfig,
	saveAdvisorSettings,
	type AdvisorConfig,
	type LoadedConfig,
} from "./config.ts";
import {
	ADVISORY_TYPE,
	BLOCK_BASE_MS,
	BLOCK_CAP_MS,
	HANDOFF_IN_PROGRESS_KEY,
	HANDOFF_SESSION_REPLACED_CHANNEL,
	STATUS_KEY,
} from "./constants.ts";
import { createAdvisorStreamFn, formatAdvisorModelSpec, resolveAdvisorModel } from "./model.ts";
import { loadAdvisorPrompt } from "./prompt.ts";
import { AdvisorRuntime } from "./runtime.ts";
import { AdvisorSession, PersistenceError, advisorSessionPath, type AdvisorCheckpoint } from "./session.ts";
import { resolveAdvisorTools } from "./tools.ts";
import { MonitorStore, formatTurnDelta } from "./transcript.ts";
import type { MonitorHost } from "./ui/monitor.ts";

function handoffInProgress(): boolean {
	return !!(globalThis as Record<symbol, unknown>)[HANDOFF_IN_PROGRESS_KEY];
}

function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		return Array.isArray(message.content)
			? message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
			: String(message.content);
	}
	if (message.role === "assistant") {
		return message.content
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}
	if (message.role === "toolResult") {
		return Array.isArray(message.content)
			? message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
			: "";
	}
	return "";
}

function observedRef(ctx: ExtensionContext) {
	return {
		id: ctx.sessionManager.getSessionId(),
		file: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
	};
}

export default function (pi: ExtensionAPI) {
	let loaded: LoadedConfig | undefined;
	let runtime: AdvisorRuntime | undefined;
	let session: AdvisorSession | undefined;
	let adviseTool: AdviseTool | undefined;
	let unsubscribeAgent: (() => void) | undefined;
	let activeModelLabel: string | undefined;
	let activeThinking: string | undefined;
	let builtForCwd: string | undefined;
	let builtIdentity: string | undefined;
	let pendingUserPrompt: string | undefined;
	let consecutiveBlocks = 0;
	let autoResumeSuppressed = false;
	let turnState: PrimaryTurnState = "ended-nonterminal";
	let persistenceFailed = false;
	let unavailable: string | undefined;
	const store = new MonitorStore();
	const reviewedEntryIds = new Set<string>();

	const dbg = (...a: unknown[]) => {
		if (loaded?.effective.debug) console.error("[advisor]", ...a);
	};

	function configOf(ctx: { cwd: string; isProjectTrusted: () => boolean }): LoadedConfig {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		return loaded;
	}

	function updateStatus(ctx: unknown): void {
		const ui = (ctx as { ui?: { setStatus?: (k: string, t: string | undefined) => void; theme?: { fg: (c: string, s: string) => string } } }).ui;
		if (!ui?.setStatus) return;
		if (!loaded?.effective.review || !runtime) {
			ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const bar = ui.theme ? ui.theme.fg("dim", "│") : "│";
		ui.setStatus(STATUS_KEY, `${bar} Advisor: $${runtime.usage.cost.toFixed(2)}`);
	}

	function sendNit(note: string, severity: AdvisorSeverity | undefined, finalAnswer: boolean, id = newAdviceId()): void {
		const notes: AdvisorNote[] = [{ note, severity }];
		const content = formatAdvisoryContent(notes, { stale: true, finalAnswer });
		pi.sendMessage(
			{ customType: ADVISORY_TYPE, content, display: true, details: { notes: notes.map((n) => ({ ...n, id })) } },
			{ deliverAs: "steer", triggerTurn: !autoResumeSuppressed },
		);
		session?.appendAdvice("delivered", { note, severity }, id);
	}

	function flushNits(rt: AdvisorRuntime | undefined): void {
		if (!rt || handoffInProgress()) return;
		for (const n of rt.takeNits()) {
			const id = newAdviceId();
			sendNit(n.note, n.severity, false, id);
			adviseTool?.markDelivered(n.note, n.severity);
		}
	}

	function deliverAdvice(note: string, severity?: AdvisorSeverity, sourceRuntime?: AdvisorRuntime): boolean {
		if (handoffInProgress()) return false;
		const targetRuntime = sourceRuntime ?? runtime;
		if (!loaded?.effective.review || (sourceRuntime && sourceRuntime !== runtime) || (targetRuntime && !targetRuntime.acceptingAdvice)) {
			dbg("dropping stale/disabled advice", severity, JSON.stringify(note).slice(0, 80));
			return false;
		}
		if (targetRuntime) {
			targetRuntime.enqueueAdvice(note, severity);
			session?.appendAdvice("held", { note, severity }, newAdviceId());
			store.append({ kind: "advice", title: `held ${(severity ?? "nit").toUpperCase()}`, body: note });
			return false;
		}
		if (!isHighSeverity(severity) && turnState !== "running") {
			sendNit(note, severity, turnState === "ended-terminal");
			return true;
		}
		return false;
	}

	function deliverHeld(notes: AdvisorNote[], opts?: { terminal?: boolean }): void {
		if (handoffInProgress() || !notes.length) return;
		const finalAnswer = turnState === "ended-terminal";
		if (opts && opts.terminal !== undefined && opts.terminal !== finalAnswer) {
			dbg("deliverHeld: opts.terminal diverged from turnState", opts.terminal, turnState);
		}
		for (const n of notes) {
			const id = newAdviceId();
			const content = formatAdvisoryContent([n], { finalAnswer, stale: !isHighSeverity(n.severity) });
			pi.sendMessage(
				{ customType: ADVISORY_TYPE, content, display: true, details: { notes: [{ ...n, id }] } },
				{ deliverAs: "steer", triggerTurn: !autoResumeSuppressed },
			);
			adviseTool?.markDelivered(n.note, n.severity);
			session?.appendAdvice("delivered", n, id);
			store.append({ kind: "advice", title: `delivered ${(n.severity ?? "nit").toUpperCase()}`, body: n.note });
		}
	}

	function flushSettledAdvice(outcome: "ok" | "failed"): void {
		if (outcome !== "ok" || !runtime || handoffInProgress()) return;
		if (turnState === "ended-terminal") {
			const notes = runtime.takeAllAdvice();
			if (notes.length) deliverHeld(notes, { terminal: true });
		} else if (turnState === "ended-nonterminal") {
			flushNits(runtime);
		}
		persistCheckpoint("review-complete", outcome);
	}

	function persistCheckpoint(kind: AdvisorCheckpoint["kind"], outcome?: AdvisorCheckpoint["reviewOutcome"], ctx?: ExtensionContext): void {
		if (!session) return;
		session.checkpoint({
			version: 1,
			kind,
			observedSessionId: ctx?.sessionManager.getSessionId(),
			observedSessionFile: ctx?.sessionManager.getSessionFile(),
			observedLeafId: ctx?.sessionManager.getLeafId() ?? null,
			reviewedEntryIds: [...reviewedEntryIds],
			heldAdvice: runtime?.snapshotAdvice() ?? [],
			delivered: adviseTool?.snapshotDelivered() ?? [],
			reviewOutcome: outcome,
		});
	}

	function closeSession(): void {
		unsubscribeAgent?.();
		unsubscribeAgent = undefined;
		try {
			session?.close();
		} catch {}
		session = undefined;
	}

	function teardownRuntime(): void {
		unsubscribeAgent?.();
		unsubscribeAgent = undefined;
		runtime?.dispose();
		runtime = undefined;
		adviseTool = undefined;
		activeModelLabel = undefined;
		activeThinking = undefined;
		builtForCwd = undefined;
		builtIdentity = undefined;
		pendingUserPrompt = undefined;
		consecutiveBlocks = 0;
		autoResumeSuppressed = false;
		turnState = "ended-nonterminal";
	}

	function attachAgent(agent: Agent, sm: AdvisorSession | undefined): void {
		unsubscribeAgent?.();
		const live = new Map<string, string>();
		unsubscribeAgent = agent.subscribe((event: AgentEvent) => {
			if (event.type === "message_start") {
				const kind = event.message.role === "user" ? "user" : event.message.role === "assistant" ? "assistant" : "tool-result";
				const rec = store.append({
					kind,
					title: event.message.role,
					body: messageText(event.message),
					streaming: event.message.role === "assistant",
				});
				if ("timestamp" in event.message) live.set(String(event.message.timestamp), rec.id);
			} else if (event.type === "message_update") {
				const key = String(event.message.timestamp);
				const id = live.get(key);
				if (id) store.update(id, { body: messageText(event.message), streaming: true });
			} else if (event.type === "message_end") {
				const key = String(event.message.timestamp);
				const id = live.get(key);
				if (id) store.update(id, { body: messageText(event.message), streaming: false });
				live.delete(key);
				try {
					sm?.appendMessage(event.message);
				} catch (err) {
					handlePersistError(err);
				}
			} else if (event.type === "tool_execution_start") {
				store.append({ kind: "tool", title: event.toolName, body: JSON.stringify(event.args ?? {}, null, 2) });
			} else if (event.type === "tool_execution_end") {
				store.append({
					kind: "tool-result",
					title: event.toolName + (event.isError ? " (error)" : ""),
					body: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {}),
				});
			}
		});
	}

	function handlePersistError(err: unknown): void {
		persistenceFailed = true;
		const message = err instanceof PersistenceError ? err.message : String(err);
		store.append({ kind: "error", title: "persist failed", body: message });
		teardownRuntime();
	}

	function openSession(ctx: ExtensionContext): AdvisorSession | undefined {
		const file = ctx.sessionManager.getSessionFile();
		const expected = file ? advisorSessionPath(file) : undefined;
		if (session && session.path === expected) return session;
		closeSession();
		try {
			session = AdvisorSession.open(observedRef(ctx));
			session.onError = handlePersistError;
			store.replace(session.historyEvents());
			return session;
		} catch (err) {
			handlePersistError(err);
			unavailable = err instanceof Error ? err.message : String(err);
			return undefined;
		}
	}

	function identityKey(cfg: AdvisorConfig, cwd: string): string {
		return `${cwd}|${cfg.model}|${cfg.tools.join(",")}|${cfg.instructions}`;
	}

	async function ensureRuntime(ctx: ExtensionContext): Promise<AdvisorRuntime | undefined> {
		const cfg = (loaded ?? configOf(ctx)).effective;
		if (!cfg.review || persistenceFailed) return undefined;
		const sm = openSession(ctx);
		if (runtime && builtForCwd === ctx.cwd && builtIdentity === identityKey(cfg, ctx.cwd)) return runtime;
		if (runtime) {
			persistCheckpoint("config-revision", undefined, ctx);
			teardownRuntime();
		}

		const resolved = resolveAdvisorModel(ctx.modelRegistry, cfg.model);
		if ("error" in resolved) {
			unavailable = resolved.error;
			store.append({ kind: "error", title: "model unavailable", body: resolved.error });
			return undefined;
		}
		unavailable = undefined;
		const prompt = loadAdvisorPrompt({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			model: resolved.model,
			instructions: cfg.instructions,
			tools: cfg.tools,
		});
		let builtRuntime!: AdvisorRuntime;
		const builtAdviseTool = new AdviseTool((note, severity) => deliverAdvice(note, severity, builtRuntime));
		adviseTool = builtAdviseTool;
		const tools = resolveAdvisorTools(ctx.cwd, cfg.tools, builtAdviseTool);
		if (tools.unknown.length) {
			store.append({
				kind: "error",
				title: "unavailable tools",
				body: `Not attachable from this extension: ${tools.unknown.join(", ")}`,
			});
		}
		const agent = new Agent({
			initialState: {
				systemPrompt: prompt.text,
				model: resolved.model,
				thinkingLevel: resolved.model.reasoning ? (resolved.thinkingLevel as never) : ("off" as never),
				tools: tools.tools as never,
			},
			convertToLlm,
			streamFn: createAdvisorStreamFn(ctx.modelRegistry),
			getApiKey: (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider),
		});
		builtRuntime = new AdvisorRuntime(
			agent,
			builtAdviseTool,
			1000,
			dbg,
			cfg.compactPct,
			(outcome) => {
				if (runtime === builtRuntime) flushSettledAdvice(outcome);
			},
			{
				onSoftReset: () => {
					store.marker("self-compaction");
					sm?.contextReset("self-compaction");
				},
				onReviewStart: () => persistCheckpoint("review-start", undefined, ctx),
				onReviewComplete: (outcome) => persistCheckpoint("review-complete", outcome, ctx),
			},
		);
		attachAgent(agent, sm);
		if (sm) {
			const restored = sm.restore(ctx.sessionManager.getLeafId(), new Set(ctx.sessionManager.getBranch().map((e) => e.id)));
			agent.state.messages = restored.messages as typeof agent.state.messages;
			builtRuntime.hydrateAdvice(restored.heldAdvice);
			builtAdviseTool.restoreDelivered(restored.delivered);
			builtRuntime.hydrateAccounting(restored.lifetime);
			for (const id of restored.reviewedEntryIds) reviewedEntryIds.add(id);
			if (restored.interrupted) store.marker("interrupted review restored");
		}
		runtime = builtRuntime;
		activeModelLabel = formatAdvisorModelSpec(resolved.model);
		activeThinking = resolved.thinkingLevel;
		builtForCwd = ctx.cwd;
		builtIdentity = identityKey(cfg, ctx.cwd);
		dbg("built advisor runtime, model=", activeModelLabel);
		return runtime;
	}

	function applyConfig(next: LoadedConfig, ctx?: ExtensionContext): void {
		const prev = loaded?.effective;
		loaded = next;
		if (!next.effective.review) {
			persistCheckpoint("shutdown", undefined, ctx);
			teardownRuntime();
			return;
		}
		if (prev && identityConfigChanged(prev, next.effective)) teardownRuntime();
		if (ctx && next.effective.review && !runtime) void ensureRuntime(ctx);
	}

	pi.on("before_agent_start", (event) => {
		if (!loaded?.effective.review) return;
		autoResumeSuppressed = false;
		turnState = "running";
		pendingUserPrompt = event.prompt;
	});

	pi.on("turn_start", () => {
		if (!loaded?.effective.review) return;
		turnState = "running";
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!loaded) loaded = configOf(ctx);
		if (!loaded.effective.review) return;
		const terminal = isTerminalTurn(event.message as { content?: Array<{ type: string }> });
		turnState = terminal ? "ended-terminal" : "ended-nonterminal";
		if (!loaded.effective.review) return;

		const rt = await ensureRuntime(ctx);
		dbg("turn_end", "state=", turnState, "runtime=", !!rt, "model=", activeModelLabel);
		if (!rt) return;
		if (!terminal) flushNits(rt);

		const delta = formatTurnDelta({
			userPrompt: pendingUserPrompt,
			assistant: event.message as AssistantMessage,
			toolResults: event.toolResults as ToolResultMessage[],
		});
		pendingUserPrompt = undefined;
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf) reviewedEntryIds.add(leaf);
		rt.push(delta);
		if (handoffInProgress()) return;
		updateStatus(ctx);
		consecutiveBlocks = await runTurnBlock({
			terminal,
			runtime: rt,
			consecutiveBlocks,
			baseMs: BLOCK_BASE_MS,
			capMs: BLOCK_CAP_MS,
			signal: ctx.signal,
			notify: (m) => {
				try {
					ctx.ui.notify?.(m, "info");
				} catch {}
			},
			deliverHeld,
		});
		if (ctx.signal?.aborted) autoResumeSuppressed = true;
		updateStatus(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		store.marker("primary compaction");
		session?.contextReset("primary-compaction");
		persistCheckpoint("primary-compact", undefined, ctx);
		runtime?.reset();
		reviewedEntryIds.clear();
		updateStatus(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		store.marker("primary tree navigation");
		session?.contextReset("primary-tree");
		persistCheckpoint("primary-tree", undefined, ctx);
		if (runtime) {
			runtime.reset();
			void ensureRuntime(ctx);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		loaded = configOf(ctx);
		persistenceFailed = false;
		reviewedEntryIds.clear();
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			teardownRuntime();
			closeSession();
			store.clear();
		}
		openSession(ctx);
		if (loaded.effective.review) await ensureRuntime(ctx);
		updateStatus(ctx);
	});

	pi.events.on(HANDOFF_SESSION_REPLACED_CHANNEL, () => {
		teardownRuntime();
		closeSession();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		persistCheckpoint("shutdown", undefined, ctx);
		await session?.flush().catch(() => {});
		teardownRuntime();
		closeSession();
		ctx.ui.setStatus?.(STATUS_KEY, undefined);
	});

	pi.registerMessageRenderer<{ notes: AdvisorNote[] }>(ADVISORY_TYPE, (message, _options, theme) => {
		const notes = message.details?.notes;
		if (!notes?.length) return undefined;
		const container = new Container();
		for (const n of notes) {
			const color = n.severity === "blocker" ? "error" : n.severity === "concern" ? "warning" : "dim";
			const tag = (n.severity ?? "nit").toUpperCase();
			container.addChild(new Text(`${theme.fg(color, `◆ advisor [${tag}]`)} ${theme.fg("muted", n.note)}`, 1, 0));
		}
		return container;
	});

	const host: AdvisorCommandHost = {
		getConfig: () => loaded ?? loadConfig(".", false),
		applyConfig: (next, ctx) => applyConfig(next, ctx),
		isReviewEnabled: () => !!loaded?.effective.review,
		async setReview(enabled, ctx, scope) {
			const result = saveAdvisorSettings(scope, ctx.cwd, { review: enabled });
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			const next = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			applyConfig(next, ctx);
			if (scope === "user" && next.provenance.review === "project" && next.effective.review !== enabled) {
				ctx.ui.notify(`Saved user review=${enabled}, but project still overrides to ${next.effective.review}`, "warning");
				updateStatus(ctx);
				return;
			}
			if (enabled) {
				const rt = await ensureRuntime(ctx);
				updateStatus(ctx);
				ctx.ui.notify(rt ? `advisor on — ${activeModelLabel}` : `advisor on, but ${unavailable ?? "no advisor model available"}`, rt ? "info" : "warning");
			} else {
				updateStatus(ctx);
				ctx.ui.notify("advisor off", "info");
			}
		},
		async statusText(ctx) {
			const cfg = configOf(ctx);
			if (!cfg.effective.review) return "advisor disabled (review=false)";
			const rt = await ensureRuntime(ctx);
			if (!rt) return `advisor enabled but ${unavailable ?? "no advisor model is available"}`;
			updateStatus(ctx);
			const u = rt.usage;
			const ctxStr = u.contextPercent !== null ? `${u.contextPercent}% (${u.contextTokens} tok)` : `${u.contextTokens} tok`;
			const prompt = loadAdvisorPrompt({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				instructions: cfg.effective.instructions,
				tools: cfg.effective.tools,
			});
			const path = session?.path ?? (ctx.sessionManager.getSessionFile() ? "opening…" : "ephemeral");
			return [
				`advisor enabled — model ${activeModelLabel}${activeThinking ? `:${activeThinking}` : ""}`,
				`backlog ${rt.backlog}, tokens ${u.input}in/${u.output}out, cost $${u.cost.toFixed(4)}, ctx ${ctxStr}`,
				`session ${path}`,
				`prompt base ${prompt.base}${prompt.files.systemPath ? ` (${prompt.files.systemPath})` : ""}; append ${prompt.append}`,
			].join("\n");
		},
		monitorHost(ctx): MonitorHost {
			if (!loaded) loaded = configOf(ctx);
			openSession(ctx);
			return {
				store,
				sessionPath: session?.path,
				ephemeral: !ctx.sessionManager.getSessionFile(),
				review: loaded.effective.review,
				modelLabel: activeModelLabel,
				thinkingLevel: activeThinking,
				stateLabel: persistenceFailed ? "persist-failed" : runtime ? (runtime.idle ? "idle" : "reviewing") : "stopped",
				usage: runtime?.usage,
				backlog: runtime?.backlog ?? 0,
				unavailable,
			};
		},
		injectTestAdvice(severity, note) {
			if (severity === "nit" && turnState !== "running") sendNit(note, severity, turnState === "ended-terminal");
			else deliverAdvice(note, severity);
		},
	};

	registerAdvisorCommand(pi, host);
}

export { AdvisorRuntime } from "./runtime.ts";
export {
	AdviseTool,
	formatAdvisoryContent,
	formatReconfirmPreamble,
	isHighSeverity,
	isTerminalTurn,
	nextBackoffMs,
	parseAdvisorTestArgs,
	runTurnBlock,
} from "./advice.ts";
export { buildReviewMessages, formatTurnDelta } from "./transcript.ts";
