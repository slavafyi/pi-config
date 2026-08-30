import assert from "node:assert/strict";
import test from "node:test";

import planMode, { MODE_GUARD_PROMPT } from "./index.ts";

function createHarness(initialEntries: any[] = []) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const setActiveToolsCalls: string[][] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const entries = [...initialEntries];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	const pendingCustomMessages: any[] = [];
	let themeName = "light";
	let unsubscribed = false;
	let agentRunActive = false;

	function appendCustomMessage(message: any): void {
		entries.push({ type: "custom_message", ...message });
	}

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
		registerEntryRenderer: (customType: string, renderer: (entry: any, options: any, theme: any) => any) =>
			entryRenderers.set(customType, renderer),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		setActiveTools: (tools: string[]) => setActiveToolsCalls.push(tools),
		sendMessage: (message: any, options: any) => {
			sentMessages.push({ message, options });
			if (agentRunActive && options?.triggerTurn === false) {
				pendingCustomMessages.push(message);
			} else {
				appendCustomMessage(message);
			}
		},
		sendUserMessage: () => {},
	};
	const ctx = {
		hasUI: true,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			buildContextEntries: () => entries,
		},
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

	async function startAgent() {
		const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
		if (result?.message) appendCustomMessage(result.message);
		return result;
	}

	async function updateMessage(event: any): Promise<void> {
		agentRunActive = true;
		await handlers.get("message_update")?.(event, ctx);
	}

	async function endMessage(event: any): Promise<void> {
		agentRunActive = true;
		await handlers.get("message_end")?.(event, ctx);
	}

	async function endTurn(event: any): Promise<void> {
		agentRunActive = true;
		await handlers.get("turn_end")?.(event, ctx);
		for (const message of pendingCustomMessages.splice(0)) appendCustomMessage(message);
	}

	async function endAgent(event: any): Promise<void> {
		agentRunActive = true;
		await handlers.get("agent_end")?.(event, ctx);
	}

	return {
		commands,
		ctx,
		entries,
		entryRenderers,
		eventHandlers,
		handlers,
		endAgent,
		endMessage,
		endTurn,
		sentMessages,
		setActiveToolsCalls,
		startAgent,
		statuses,
		updateMessage,
		widgets,
		setThemeName: (name: string) => {
			themeName = name;
		},
		wasUnsubscribed: () => unsubscribed,
	};
}

test("publishes only plan state transitions while preserving progress UI", async () => {
	const harness = createHarness();
	const {
		commands,
		ctx,
		entries,
		entryRenderers,
		eventHandlers,
		handlers,
		endAgent,
		endMessage,
		endTurn,
		sentMessages,
		setActiveToolsCalls,
		startAgent,
		statuses,
		updateMessage,
		widgets,
	} = harness;
	await handlers.get("session_start")?.({}, ctx);

	const normal = await startAgent();
	assert.equal(normal.systemPrompt, `base\n\n${MODE_GUARD_PROMPT}`);
	assert.equal(normal.message, undefined);

	await commands.get("plan")?.("", ctx);
	assert.equal(statuses.at(-1), "light:warning:⏸︎ plan");
	harness.setThemeName("dark");
	const statusesBeforeInvalidate = statuses.length;
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.equal(statuses.at(-1), "dark:warning:⏸︎ plan");
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.equal(statuses.length, statusesBeforeInvalidate + 1);

	const planning = await startAgent();
	assert.equal(planning.systemPrompt, normal.systemPrompt);
	assert.equal(planning.message.customType, "plan-mode-context");
	assert.equal((await startAgent()).message, undefined);
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "edit", input: {} }, ctx), {
		block: true,
		reason: "Plan mode: edit is blocked. Continue with read-only analysis.",
	});
	assert.equal(
		await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "git status" } }, ctx),
		undefined,
	);
	assert.match(
		(await handlers.get("tool_call")?.({ toolName: "bash", input: { command: "rm file" } }, ctx)).reason,
		/ask the user to exit plan mode/,
	);

	await endAgent(
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Inspect the cache behavior\n2. Apply the focused fix" }],
				},
			],
		},
	);
	assert.equal(sentMessages.length, 1);
	assert.equal(sentMessages[0].message.customType, "plan-mode-execute");
	assert.match(sentMessages[0].message.content, /^\[EXECUTING PLAN\]/);
	assert.match(sentMessages[0].message.content, /Immediately after completing step n/);
	assert.doesNotMatch(sentMessages[0].message.content, /Full tool access/);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal((await startAgent()).message, undefined);
	assert.deepEqual(setActiveToolsCalls, []);
	assert.equal(handlers.has("context"), false);
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");
	assert.ok(widgets.at(-1)?.every((line) => line.includes("dark:muted:○ ")));

	const firstDoneMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "The first step is complete. [DONE:1]" },
			{ type: "toolCall", name: "bash", id: "next-step", arguments: { command: "pwd" } },
		],
	};
	const persistedStatesBeforeMessageEnd = entries.filter(
		(entry) => entry.type === "custom" && entry.customType === "plan-mode",
	).length;
	await updateMessage({
		message: { role: "assistant", content: [{ type: "text", text: "The first step is complete. [DONE:" }] },
	});
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");
	await updateMessage({ message: firstDoneMessage });
	assert.equal(statuses.at(-1), "dark:accent:● 1/2");
	await endMessage({ message: firstDoneMessage });
	assert.equal(statuses.at(-1), "dark:accent:● 1/2");
	assert.match(widgets.at(-1)?.[0] ?? "", /dark:success:✓ .*~Inspect the cache behavior~/);
	assert.match(widgets.at(-1)?.[1] ?? "", /dark:muted:○ .*Apply the focused fix/);
	assert.equal(
		entries.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode").length,
		persistedStatesBeforeMessageEnd,
	);

	await endTurn({ message: firstDoneMessage });
	const persistedStatesAfterToolResult = entries.filter(
		(entry) => entry.type === "custom" && entry.customType === "plan-mode",
	);
	assert.equal(persistedStatesAfterToolResult.length, persistedStatesBeforeMessageEnd + 1);
	assert.equal(persistedStatesAfterToolResult.at(-1)?.data.todos[0].completed, true);

	const updatedExecution = await startAgent();
	assert.equal(updatedExecution.message.customType, "plan-execution-context");
	assert.doesNotMatch(updatedExecution.message.content, /Inspect the cache behavior/);
	assert.match(updatedExecution.message.content, /Apply the focused fix/);
	assert.equal((await startAgent()).message, undefined);

	const secondDoneMessage = {
		role: "assistant",
		content: [{ type: "text", text: "The second step is complete. [DONE:2]" }],
	};
	await endMessage({ message: secondDoneMessage });
	assert.equal(statuses.at(-1), "dark:accent:● 2/2");
	assert.notEqual(widgets.at(-1), undefined);
	assert.equal(sentMessages.length, 1);

	await endTurn({ message: secondDoneMessage });
	assert.equal(sentMessages.length, 2);
	const stateAvailableBeforeAgentEnd = [...entries]
		.reverse()
		.find((entry) => entry.type === "custom_message" && entry.customType === "plan-normal-context");
	assert.ok(stateAvailableBeforeAgentEnd);
	assert.equal(entries.some((entry) => entry.type === "custom" && entry.customType === "plan-complete"), false);

	await endTurn({
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Completion already reported. [DONE:2]" }],
		},
	});
	assert.equal(sentMessages.length, 2);

	await endAgent({ messages: [] });
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(sentMessages.length, 2);
	assert.deepEqual(sentMessages[1], {
		message: {
			customType: "plan-normal-context",
			content: "[NORMAL MODE ACTIVE]\nPlan-mode restrictions are inactive.",
			display: false,
		},
		options: { triggerTurn: false },
	});
	const stateAvailableToQueuedTurn = [...entries]
		.reverse()
		.find((entry) => entry.type === "custom_message" && entry.customType === "plan-normal-context");
	assert.ok(stateAvailableToQueuedTurn);
	assert.equal((await startAgent()).message, undefined);
	assert.equal(sentMessages.length, 2);

	const completionEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "plan-complete");
	assert.deepEqual(completionEntry?.data, {
		items: ["Inspect the cache behavior", "Apply the focused fix"],
	});
	const completionRenderer = entryRenderers.get("plan-complete");
	assert.ok(completionRenderer);
	const completionComponent = completionRenderer(completionEntry, {}, {
		bold: (text: string) => `**${text}**`,
		fg: (tone: string, text: string) => `${tone}:${text}`,
	});
	assert.match(completionComponent.render(80).join("\n"), /success:\*\*✓ Plan Complete\*\*/);
	assert.match(completionComponent.render(80).join("\n"), /muted:Apply the focused fix/);

	harness.setThemeName("light-again");
	eventHandlers.get("footer:invalidate")?.(undefined);
	assert.equal(widgets.at(-1), undefined);

	handlers.get("session_shutdown")?.({}, ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(widgets.at(-1), undefined);
	assert.equal(harness.wasUnsubscribed(), true);
});

test("restores execution progress without applying legacy tool state", async () => {
	const entries = [
		{
			type: "custom_message",
			customType: "plan-mode-execute",
			content: "[EXECUTING PLAN]",
		},
		{
			type: "custom",
			customType: "plan-mode",
			data: {
				enabled: false,
				executing: true,
				toolsBeforePlanMode: ["read"],
				todos: [
					{ step: 1, text: "Inspect state", completed: false },
					{ step: 2, text: "Apply fix", completed: false },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Inspection complete. [DONE:1]" }],
			},
		},
	];
	const harness = createHarness(entries);
	await harness.handlers.get("session_start")?.({}, harness.ctx);

	assert.deepEqual(harness.setActiveToolsCalls, []);
	assert.equal(harness.statuses.at(-1), "light:accent:● 1/2");
	assert.match(harness.widgets.at(-1)?.[0] ?? "", /light:success:✓ .*~Inspect state~/);
	assert.match(harness.widgets.at(-1)?.[1] ?? "", /light:muted:○ .*Apply fix/);
});
