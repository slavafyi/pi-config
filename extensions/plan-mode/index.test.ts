import assert from "node:assert/strict";
import test from "node:test";

import planMode, { MODE_GUARD_PROMPT } from "./index.ts";

test("changes modes without changing the provider tool prefix", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const setActiveToolsCalls: string[][] = [];
	const entries: any[] = [];
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> },
		) => commands.set(name, command.handler),
		registerShortcut: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		setActiveTools: (tools: string[]) => setActiveToolsCalls.push(tools),
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getEntries: () => entries },
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			select: async () => "Execute the plan (track progress)",
			editor: async () => undefined,
			theme: {
				fg: (_tone: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	planMode(pi as any);
	await handlers.get("session_start")?.({}, ctx);

	const normal = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.equal(normal.systemPrompt, `base\n\n${MODE_GUARD_PROMPT}`);
	assert.equal(normal.message.customType, "plan-normal-context");

	await commands.get("plan")?.("", ctx);
	const planning = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.equal(planning.systemPrompt, normal.systemPrompt);
	assert.equal(planning.message.customType, "plan-mode-context");
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx), {
		block: true,
		reason: "Plan mode: edit is blocked. Use /plan to disable plan mode first.",
	});
	assert.equal(
		await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git status" } }, ctx),
		undefined,
	);
	assert.equal(
		(await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm file" } }, ctx)).block,
		true,
	);

	await handlers.get("agent_end")?.(
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Inspect the cache behavior\n2. Apply the focused fix" }],
				},
			],
		},
		ctx,
	);
	const execution = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.equal(execution.systemPrompt, normal.systemPrompt);
	assert.equal(execution.message.customType, "plan-execution-context");
	assert.match(execution.message.content, /Inspect the cache behavior/);
	assert.deepEqual(setActiveToolsCalls, []);
	assert.equal(handlers.has("context"), false);
});
