import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import planMode, { MODE_GUARD_PROMPT } from "./index.ts";

function createHarness(initialEntries: any[] = [], activeBranch?: any[]) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const entryRenderers = new Map<string, (entry: any, options: any, theme: any) => any>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const setActiveToolsCalls: string[][] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const entries = [...initialEntries];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<string[] | undefined> = [];
	let widgetComponent: { render(width: number): string[] } | undefined;
	const pendingCustomMessages: any[] = [];
	const notifications: string[] = [];
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
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => activeBranch ?? entries,
			buildContextEntries: () => activeBranch ?? entries,
		},
		ui: {
			notify: (text: string) => notifications.push(text),
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
			setWidget: (_id: string, value: any) => {
				widgetComponent = typeof value === "function" ? value({}, ctx.ui.theme) : undefined;
				widgets.push(Array.isArray(value) ? value : widgetComponent?.render(80));
			},
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
		notifications,
		renderWidget: (width: number) => widgetComponent?.render(width),
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
	assert.match(sentMessages[0].message.content, /Write \[DONE:n\] in your own assistant text message/);
	assert.match(sentMessages[0].message.content, /not in tool output, codemode text\(\)\/console\.log\(\), or a subagent response/);
	assert.doesNotMatch(sentMessages[0].message.content, /Full tool access/);
	assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
	assert.equal((await startAgent()).message, undefined);
	assert.deepEqual(setActiveToolsCalls, []);
	assert.equal(handlers.has("context"), false);
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");
	assert.ok(widgets.at(-1)?.every((line) => line.includes("dark:muted:○ ")));

	await endMessage({ message: { role: "toolResult", toolName: "codemode", content: [{ type: "text", text: "[DONE:1]" }] } });
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");

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
		message: firstDoneMessage,
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "ignored", partial: firstDoneMessage },
	});
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");
	const partialDoneMessage = {
		role: "assistant",
		content: [{ type: "text", text: "The first step is complete. [DONE:" }],
	};
	await updateMessage({
		message: partialDoneMessage,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "The first step is complete. [DONE:",
			partial: partialDoneMessage,
		},
	});
	assert.equal(statuses.at(-1), "dark:accent:● 0/2");
	await updateMessage({
		message: firstDoneMessage,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "1]", partial: firstDoneMessage },
	});
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

test("keeps full plan instructions in persistence, execution, resume, and completion", async () => {
	const title = "Run the long plan check, preserve every condition, and verify the final result";
	const fullStep = `${title} - Background: check the date. - Foreground: check Git.`;
	const harness = createHarness();
	await harness.commands.get("plan")?.("", harness.ctx);
	await harness.endAgent({ messages: [{ role: "assistant", content: [{ type: "text", text: `Plan:\n1. ${title}\n   - Background: check the date.\n   - Foreground: check Git.` }] }] });
	const state = harness.entries.filter((entry) => entry.customType === "plan-mode").at(-1);
	assert.equal(state.data.todos[0].text, fullStep);
	assert.ok(harness.sentMessages.at(-1)?.message.content.includes(fullStep));
	await harness.commands.get("todos")?.("", harness.ctx);
	assert.ok(harness.notifications.at(-1)?.includes(fullStep));
	assert.ok(!harness.widgets.at(-1)?.[0]?.includes("final result"));

	const restored = createHarness(harness.entries);
	await restored.handlers.get("session_start")?.({}, restored.ctx);
	assert.equal((await restored.startAgent()).message, undefined);
	assert.ok(restored.entries.find((entry) => entry.customType === "plan-mode-execute")?.content.includes(fullStep));
	const done = { role: "assistant", content: [{ type: "text", text: "[DONE:1]" }] };
	await restored.endMessage({ message: done });
	await restored.endTurn({ message: done });
	await restored.endAgent({ messages: [done] });
	const completion = restored.entries.filter((entry) => entry.customType === "plan-complete");
	assert.equal(completion.length, 1);
	assert.deepEqual(completion[0].data.items, [fullStep]);
});

test("caps step labels at 50 columns while fitting narrow terminals without shortening saved text", async () => {
	const step = `Check Unicode and the full instruction: ${"界😀".repeat(30)} end`;
	const harness = createHarness();
	harness.ctx.ui.theme.fg = (_tone, text) => `\x1b[36m${text}\x1b[0m`;
	harness.ctx.ui.theme.strikethrough = (text) => `\x1b[9m${text}\x1b[0m`;
	await harness.handlers.get("session_start")?.({}, harness.ctx);
	await harness.commands.get("plan")?.("", harness.ctx);
	await harness.endAgent({ messages: [{ role: "assistant", content: [{ type: "text", text: `Plan:\n1. ${step}` }] }] });
	for (const width of [0, 1, 2, 5, 40, 80, 240]) {
		const lines = harness.renderWidget(width)!;
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= Math.min(width, 54));
	}
	const label = truncateToWidth(step, 50, "...");
	assert.ok(stripVTControlCharacters(harness.renderWidget(240)![0]).includes(stripVTControlCharacters(label)));
	assert.ok(!harness.renderWidget(80)?.[0]?.includes(step));
	assert.deepEqual(harness.renderWidget(240), harness.renderWidget(80));
	harness.renderWidget(20);
	assert.ok(stripVTControlCharacters(harness.renderWidget(240)![0]).includes(stripVTControlCharacters(label)), "resize must restore the 50-column label");

	const done = { role: "assistant", content: [{ type: "text", text: "[DONE:1]" }] };
	await harness.endMessage({ message: done });
	assert.ok(harness.renderWidget(240)?.[0]?.includes("\x1b[9m"));
	harness.ctx.ui.theme.fg = (_tone, text) => `\x1b[33m${text}\x1b[0m`;
	harness.eventHandlers.get("footer:invalidate")?.(undefined);
	assert.ok(harness.renderWidget(240)?.[0]?.includes("\x1b[33m"));
	await harness.endTurn({ message: done });
	await harness.endAgent({ messages: [done] });
	const completion = harness.entries.find((entry) => entry.customType === "plan-complete");
	assert.deepEqual(completion.data.items, [step]);
	const component = harness.entryRenderers.get("plan-complete")!(completion, {}, {
		bold: (text: string) => text,
		fg: (_tone: string, text: string) => `\x1b[33m${text}\x1b[0m`,
	});
	for (const width of [0, 1, 2, 5, 40, 80, 240]) {
		const lines = component.render(width);
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= Math.min(width, 54)));
	}
	assert.ok(stripVTControlCharacters(component.render(240)[1]).includes(stripVTControlCharacters(label)));
	assert.ok(!component.render(80)[1].includes(step));
	assert.deepEqual(component.render(240), component.render(80));
});

test("keeps 50-column labels intact and truncates longer labels", async () => {
	const steps = ["x".repeat(50), "y".repeat(51)];
	const harness = createHarness([{ type: "custom", customType: "plan-mode", data: {
		enabled: false, executing: true,
		todos: steps.map((text, index) => ({ step: index + 1, text, completed: false })),
	} }]);
	harness.ctx.ui.theme.fg = (_tone, text) => text;
	await harness.handlers.get("session_start")?.({}, harness.ctx);
	const expected = [` ○ ${steps[0]} `, ` ○ ${"y".repeat(47)}... `];
	assert.deepEqual(harness.renderWidget(240)?.map(stripVTControlCharacters), expected);
	const component = harness.entryRenderers.get("plan-complete")!({ data: { items: steps } }, {}, {
		bold: (text: string) => text,
		fg: (_tone: string, text: string) => text,
	});
	assert.deepEqual(component.render(240).slice(1).map(stripVTControlCharacters), expected.map(line => line.replace("○", "✓")));
});

test("keeps muted and strikethrough styles on truncation ellipses", async () => {
	const step = "Check the long step and all mandatory conditions before completing the plan";
	const harness = createHarness([{ type: "custom", customType: "plan-mode", data: {
		enabled: false, executing: true, todos: [{ step: 1, text: step, completed: true }],
	} }]);
	const theme = {
		fg: (tone: string, text: string) => `\x1b[${tone === "muted" ? 33 : 32}m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
		strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
	};
	harness.ctx.ui.theme.fg = theme.fg;
	harness.ctx.ui.theme.strikethrough = theme.strikethrough;
	await harness.handlers.get("session_start")?.({}, harness.ctx);
	assert.ok(harness.renderWidget(30)?.[0]?.includes(theme.fg("muted", theme.strikethrough("..."))));
	const component = harness.entryRenderers.get("plan-complete")!({ data: { items: [step] } }, {}, theme);
	assert.ok(component.render(30)[1].includes(theme.fg("muted", "...")));
	assert.ok(component.render(10)[0].includes(theme.fg("success", theme.bold("..."))));
	for (const width of [0, 1, 2, 3, 10, 30, 120]) {
		assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
		assert.ok(harness.renderWidget(width)?.every(line => visibleWidth(line) <= width));
	}
});

test("keeps the existing ten-step widget limit", async () => {
	const harness = createHarness();
	await harness.commands.get("plan")?.("", harness.ctx);
	const steps = Array.from({ length: 12 }, (_, i) => `${i + 1}. Check step ${i + 1}`).join("\n");
	await harness.endAgent({ messages: [{ role: "assistant", content: [{ type: "text", text: `Plan:\n${steps}` }] }] });
	const lines = harness.renderWidget(120)!;
	assert.equal(lines.length, 11);
	assert.ok(lines.at(-1)?.includes("widget truncated"));
	const state = harness.entries.filter((entry) => entry.customType === "plan-mode").at(-1);
	assert.equal(state.data.todos.length, 12);
});

test("keeps string widgets for RPC clients without terminal components", async () => {
	const harness = createHarness();
	harness.ctx.mode = "rpc";
	await harness.commands.get("plan")?.("", harness.ctx);
	const step = "Check the long plan step and preserve its full text for the RPC client to display";
	await harness.endAgent({ messages: [{ role: "assistant", content: [{ type: "text", text: `Plan:\n1. ${step}` }] }] });
	assert.equal(harness.renderWidget(80), undefined);
	assert.ok(harness.widgets.at(-1)?.[0]?.includes(step));
});

test("restores plan state only from the active branch", async () => {
	const activeState = {
		type: "custom",
		customType: "plan-mode",
		data: { enabled: true, executing: false, todos: [] },
	};
	const abandonedState = {
		type: "custom",
		customType: "plan-mode",
		data: {
			enabled: false,
			executing: true,
			todos: [{ step: 1, text: "Abandoned branch work", completed: false }],
		},
	};
	const harness = createHarness([activeState, abandonedState], [activeState]);

	await harness.handlers.get("session_start")?.({}, harness.ctx);

	assert.equal(harness.statuses.at(-1), "light:warning:⏸︎ plan");
	assert.equal(harness.widgets.at(-1), undefined);
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
