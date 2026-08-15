import assert from "node:assert/strict";
import test from "node:test";

import planMode, { MODE_GUARD_PROMPT } from "./index.ts";

test("changes modes without changing the provider tool prefix", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const setActiveToolsCalls: string[][] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const entries: any[] = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	let themeName = "light";
	let unsubscribed = false;
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
		events: {
			on: (event: string, handler: (data: unknown) => void) => {
				eventHandlers.set(event, handler);
				return () => {
					unsubscribed = true;
					eventHandlers.delete(event);
				};
			},
		},
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: any) => Promise<void> },
		) => commands.set(name, command.handler),
		registerShortcut: () => {},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		setActiveTools: (tools: string[]) => setActiveToolsCalls.push(tools),
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
		sendUserMessage: () => {},
	};
	const ctx = {
		hasUI: true,
		sessionManager: { getEntries: () => entries },
		ui: {
			notify: () => {},
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
			setWidget: (_id: string, value: string[] | undefined) => widgets.push(value),
			select: async () => "Execute the plan (track progress)",
			editor: async () => undefined,
			theme: {
				fg: (tone: string, text: string) => `${themeName}:${tone}:${text}`,
				strikethrough: (text: string) => `~${text}~`,
			},
		},
	};

	planMode(pi as any);
	await handlers.get("session_start")?.({}, ctx);

	const normal = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
	assert.equal(normal.systemPrompt, `base\n\n${MODE_GUARD_PROMPT}`);
	assert.equal(normal.message.customType, "plan-normal-context");

	await commands.get("plan")?.("", ctx);
	assert.equal(statuses.at(-1), "light:warning:⏸ plan");
	themeName = "dark";
	const statusesBeforeInvalidate = statuses.length;
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.equal(statuses.at(-1), "dark:warning:⏸ plan");
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.equal(statuses.length, statusesBeforeInvalidate + 1);

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
	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].message.customType, "plan-mode-execute");
	assert.match(sentMessages[0].message.content, /Plan mode has ended\. Execute the plan now\./);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.deepEqual(setActiveToolsCalls, []);
	assert.equal(handlers.has("context"), false);
	assert.ok(widgets.at(-1)?.some((line) => line.includes("dark:muted:")));

	themeName = "light-again";
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.ok(widgets.at(-1)?.some((line) => line.includes("light-again:muted:")));

	handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(unsubscribed, true);
});
