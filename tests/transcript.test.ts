import { describe, expect, test } from "bun:test";
import { buildReviewMessages, formatTurnDelta } from "../src/transcript.ts";

const renderDelta = (o: Parameters<typeof formatTurnDelta>[0]) => formatTurnDelta(o);

describe("formatTurnDelta", () => {
	test("includes user, thinking, text, tool call + result", () => {
		const md = renderDelta({
			userPrompt: "do the thing",
			assistant: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me think" },
					{ type: "text", text: "here is my plan" },
					{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.js" } },
				],
			} as never,
			toolResults: [
				{ role: "toolResult", toolCallId: "1", toolName: "write", content: [{ type: "text", text: "wrote a.js" }], isError: false } as never,
			],
		});
		expect(md).toContain("#### User\n\ndo the thing");
		expect(md).toContain("<thinking>\nlet me think\n</thinking>");
		expect(md).toContain("here is my plan");
		expect(md).toContain("→ tool `write`:\npath: a.js");
		expect(md).toContain("#### Tool result: `write`\n\nwrote a.js");
	});

	test("multi-line bash command rides verbatim", () => {
		const cmd = "cat > /tmp/x <<'EOF'\nline one\nline two\nEOF";
		const md = renderDelta({
			assistant: {
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: cmd } }],
			} as never,
		});
		expect(md.includes(cmd)).toBe(true);
		expect(md.includes("\\n")).toBe(false);
	});

	test("successful edit uses result diff instead of raw blobs", () => {
		const diff = "  10 unchanged\n- 11 bootstrap 0/0\n+ 11 bootstrap 0.045% (9/20000)\n  12 unchanged";
		const md = renderDelta({
			assistant: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "1",
						name: "edit",
						arguments: {
							path: "RESULTS.md",
							edits: [
								{ oldText: "bootstrap 0/0", newText: "bootstrap 0.045% (9/20000)" },
								{ oldText: "x", newText: "y" },
							],
						},
					},
				],
			} as never,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "edit",
					content: [{ type: "text", text: "Successfully replaced 2 block(s)." }],
					details: { diff },
					isError: false,
				} as never,
			],
		});
		expect(md).toContain("→ tool `edit`(RESULTS.md) — 2 block(s); diff in tool result");
		expect(md).toContain("- 11 bootstrap 0/0");
		expect(md.includes('"oldText"')).toBe(false);
	});

	test("failed edit keeps attempted args", () => {
		const md = renderDelta({
			assistant: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "9", name: "edit", arguments: { path: "f.py", edits: [{ oldText: "needle that did not match", newText: "x" }] } },
				],
			} as never,
			toolResults: [
				{ role: "toolResult", toolCallId: "9", toolName: "edit", content: [{ type: "text", text: "Error: oldText not found" }], isError: true } as never,
			],
		});
		expect(md).toContain("needle that did not match");
		expect(md).toContain("`edit` (error)");
	});

	test("empty turn ⇒ empty string", () => {
		expect(formatTurnDelta({})).toBe("");
	});
});

describe("buildReviewMessages", () => {
	test("header turn + one user turn per delta", () => {
		const d1 = formatTurnDelta({
			userPrompt: "u",
			assistant: {
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "echo hi\nls" } }],
			} as never,
		});
		const msgs = buildReviewMessages("", [d1, "done"]);
		expect(msgs).toHaveLength(3);
		expect(msgs.every((m) => m.role === "user")).toBe(true);
		expect((msgs[0]!.content as Array<{ text: string }>)[0]!.text).toContain("### Session update");
		expect((msgs[1]!.content as Array<{ text: string }>)[0]!.text).toContain("#### User\n\nu\n\n#### Assistant");
	});
});
