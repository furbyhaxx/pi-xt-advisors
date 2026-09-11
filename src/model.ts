import type { Agent } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type ThinkingLevelName } from "./constants.ts";

export interface ResolvedAdvisorModel {
	model: Model<Api>;
	thinkingLevel: ThinkingLevelName;
	spec: string;
}

export interface ResolveModelError {
	error: string;
	spec: string;
}

function isThinkingLevel(value: string): value is ThinkingLevelName {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseAdvisorModelSpec(spec: string): {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevelName;
	fullModelId: string;
} | null {
	const trimmed = spec.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0) return null;
	const provider = trimmed.slice(0, slash);
	const rest = trimmed.slice(slash + 1);
	if (!provider || !rest) return null;
	const colon = rest.lastIndexOf(":");
	if (colon > 0) {
		const suffix = rest.slice(colon + 1);
		if (isThinkingLevel(suffix)) {
			return {
				provider,
				modelId: rest.slice(0, colon),
				thinkingLevel: suffix,
				fullModelId: rest,
			};
		}
	}
	return { provider, modelId: rest, fullModelId: rest };
}

export function formatAdvisorModelSpec(model: Model<Api>, thinkingLevel?: ThinkingLevelName): string {
	const base = `${model.provider}/${model.id}`;
	if (!thinkingLevel || thinkingLevel === "off") return base;
	return `${base}:${thinkingLevel}`;
}

export function resolveAdvisorModel(
	registry: ModelRegistry,
	spec: string,
): ResolvedAdvisorModel | ResolveModelError {
	const parsed = parseAdvisorModelSpec(spec);
	if (!parsed) return { error: `invalid model spec ${JSON.stringify(spec)}; expected provider/model[:thinking]`, spec };

	const exact = registry.find(parsed.provider, parsed.fullModelId);
	if (exact) {
		return {
			model: exact,
			thinkingLevel: "off",
			spec,
		};
	}

	if (parsed.thinkingLevel && parsed.modelId !== parsed.fullModelId) {
		const model = registry.find(parsed.provider, parsed.modelId);
		if (model) {
			return {
				model,
				thinkingLevel: model.reasoning ? parsed.thinkingLevel : "off",
				spec,
			};
		}
		return { error: `advisor model not found: ${parsed.provider}/${parsed.modelId}`, spec };
	}

	return { error: `advisor model not found: ${parsed.provider}/${parsed.fullModelId}`, spec };
}

function errorStream(model: Model<Api>, errorMessage: string) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as AssistantMessage["stopReason"],
		errorMessage,
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "error", message } as never);
	return stream;
}

export function createAdvisorStreamFn(registry: ModelRegistry): StreamFn {
	return async (model, context, options?: SimpleStreamOptions) => {
		const auth = await registry.getApiKeyAndHeaders(model);
		const provider = registry.getProvider(model.provider);
		if (!provider?.streamSimple) {
			return errorStream(model, `No streaming implementation for provider ${model.provider}`);
		}
		return provider.streamSimple(model, context, {
			...options,
			...(auth.ok
				? {
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
					}
				: {}),
		});
	};
}

export type AdvisorAgentLike = Pick<Agent, "state" | "prompt" | "abort" | "reset"> & {
	subscribe?: Agent["subscribe"];
};
