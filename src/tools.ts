import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { AdviseTool } from "./advice.ts";

const FACTORIES: Record<string, (cwd: string) => AgentTool> = {
	read: createReadTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
	bash: createBashTool,
	powershell: createPowerShellTool,
	edit: createEditTool,
	write: createWriteTool,
};

export interface ResolvedAdvisorTools {
	tools: AgentTool[];
	unknown: string[];
	reserved: string[];
}

export function resolveAdvisorTools(cwd: string, names: readonly string[], adviseTool: AdviseTool): ResolvedAdvisorTools {
	const unknown: string[] = [];
	const reserved: string[] = [];
	const seen = new Set<string>();
	const tools: AgentTool[] = [adviseTool as unknown as AgentTool];

	for (const raw of names) {
		const name = raw.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		if (name === "advise") {
			reserved.push(name);
			continue;
		}
		const factory = FACTORIES[name];
		if (!factory) {
			unknown.push(name);
			continue;
		}
		tools.push(factory(cwd));
	}

	return { tools, unknown, reserved };
}
