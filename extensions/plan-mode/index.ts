import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { FOOTER_INVALIDATE_EVENT } from "../footer/events.ts";
import { extractTodoItems, isSafeCommand, markCompletedSteps, type TodoItem } from "./utils.ts";

const PLAN_MODE_MUTATING_TOOLS = new Set(["edit", "write"]);

export const MODE_GUARD_PROMPT =
	"The latest extension-generated plan-mode state message controls the current mode. Treat older plan-mode state messages as historical context.";

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
}

interface PlanCompleteData {
	items: string[];
}

type PlanStateKind = "normal" | "planning" | "executing";

interface PlanStateMessage {
	kind: PlanStateKind;
	customType: "plan-normal-context" | "plan-mode-context" | "plan-execution-context";
	content: string;
}

const PLAN_STATE_TYPES = new Map<string, PlanStateKind>([
	["plan-normal-context", "normal"],
	["plan-mode-context", "planning"],
	["plan-mode-execute", "executing"],
	["plan-execution-context", "executing"],
]);

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
	let activeCtx: ExtensionContext | undefined;
	let renderedStatus: string | undefined;
	let renderedWidget: string[] | undefined;
	let hasRenderedStatus = false;
	let hasRenderedWidget = false;
	let completionTransitionQueued = false;
	const streamingDoneCarry = new Map<number, string>();

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerEntryRenderer("plan-complete", (entry, _options, theme) => {
		const data = entry.data as PlanCompleteData | undefined;
		const lines = [theme.fg("success", theme.bold("✓ Plan Complete"))];
		for (const item of data?.items ?? []) {
			lines.push(`${theme.fg("success", "✓ ")}${theme.fg("muted", item)}`);
		}
		return new Text(lines.join("\n"), 1, 0);
	});

	function publishStatus(ctx: ExtensionContext, next: string | undefined): void {
		if (hasRenderedStatus && next === renderedStatus) return;
		hasRenderedStatus = true;
		renderedStatus = next;
		ctx.ui.setStatus("plan-mode", next);
	}

	function sameLines(left: string[] | undefined, right: string[] | undefined): boolean {
		if (left === undefined || right === undefined) return left === right;
		return left.length === right.length && left.every((line, index) => line === right[index]);
	}

	function publishWidget(ctx: ExtensionContext, next: string[] | undefined): void {
		if (hasRenderedWidget && sameLines(next, renderedWidget)) return;
		hasRenderedWidget = true;
		renderedWidget = next ? [...next] : undefined;
		ctx.ui.setWidget("plan-todos", next);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			publishStatus(ctx, ctx.ui.theme.fg("accent", `● ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			publishStatus(ctx, ctx.ui.theme.fg("warning", "⏸︎ plan"));
		} else {
			publishStatus(ctx, undefined);
		}

		if (executionMode && todoItems.length > 0) {
			const lines = todoItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "✓ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "○ ")}${item.text}`;
			});
			publishWidget(ctx, lines);
		} else {
			publishWidget(ctx, undefined);
		}
	}

	const unsubscribeInvalidate = pi.events.on(FOOTER_INVALIDATE_EVENT, () => {
		if (activeCtx) updateStatus(activeCtx);
	});

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];
		completionTransitionQueued = false;

		if (planModeEnabled) {
			ctx.ui.notify("Plan mode enabled. Built-in write tools blocked.");
		} else {
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerCommand("todos", {
		description: "Show current plan todo list",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			const list = todoItems.map((item, i) => `${i + 1}. ${item.completed ? "✓" : "○"} ${item.text}`).join("\n");
			ctx.ui.notify(`Plan Progress:\n${list}`, "info");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	function buildNormalState(): PlanStateMessage {
		return {
			kind: "normal",
			customType: "plan-normal-context",
			content: "[NORMAL MODE ACTIVE]\nPlan-mode restrictions are inactive.",
		};
	}

	function buildPlanState(): PlanStateMessage {
		if (planModeEnabled) {
			return {
				kind: "planning",
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are blocked
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions directly when needed.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`,
			};
		}

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				kind: "executing",
				customType: "plan-execution-context",
				content: `[EXECUTING PLAN]
Plan-mode restrictions are inactive.

Remaining steps:
${todoList}

Complete one step at a time.
Immediately after completing step n, include [DONE:n] before starting the next step.`,
			};
		}

		return buildNormalState();
	}

	function getLatestPlanState(ctx: ExtensionContext): { kind: PlanStateKind; content: string } | undefined {
		const entries = ctx.sessionManager.buildContextEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry?.type === "custom_message") {
				const kind = PLAN_STATE_TYPES.get(entry.customType);
				if (kind && typeof entry.content === "string") return { kind, content: entry.content };
			}
			if (entry?.type !== "compaction") continue;
			const retainedTail = (entry as { retainedTail?: AgentMessage[] }).retainedTail;
			if (!retainedTail) continue;
			for (let tailIndex = retainedTail.length - 1; tailIndex >= 0; tailIndex--) {
				const message = retainedTail[tailIndex];
				if (message?.role !== "custom") continue;
				const kind = PLAN_STATE_TYPES.get(message.customType);
				if (kind && typeof message.content === "string") return { kind, content: message.content };
			}
		}
		return undefined;
	}

	function hasHistoricalPlanState(ctx: ExtensionContext): boolean {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message") return false;
			return PLAN_STATE_TYPES.has(entry.customType);
		});
	}

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled) return;

		if (PLAN_MODE_MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked. Continue with read-only analysis.`,
			};
		}
		if (event.toolName === "bash") {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode: command blocked (not allowlisted). Continue with read-only alternatives, or ask the user to exit plan mode if changes are required.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = buildPlanState();
		const latest = getLatestPlanState(ctx);
		const systemPrompt = `${event.systemPrompt}\n\n${MODE_GUARD_PROMPT}`;

		if (
			(!latest && state.kind === "normal" && !hasHistoricalPlanState(ctx)) ||
			(latest?.kind === state.kind && latest.content === state.content)
		) {
			return { systemPrompt };
		}

		return {
			systemPrompt,
			message: { customType: state.customType, content: state.content, display: false },
		};
	});

	function applyCompletedText(text: string, ctx: ExtensionContext): void {
		if (!executionMode || todoItems.length === 0) return;

		const completedBefore = todoItems.filter((item) => item.completed).length;
		markCompletedSteps(text, todoItems);
		if (todoItems.filter((item) => item.completed).length > completedBefore) {
			updateStatus(ctx);
		}
	}

	function applyCompletedSteps(message: AgentMessage, ctx: ExtensionContext): void {
		if (!isAssistantMessage(message)) return;
		applyCompletedText(getTextContent(message), ctx);
	}

	pi.on("message_start", async (event) => {
		if (isAssistantMessage(event.message)) streamingDoneCarry.clear();
	});

	pi.on("message_update", async (event, ctx) => {
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta") return;

		const candidate = `${streamingDoneCarry.get(update.contentIndex) ?? ""}${update.delta}`;
		applyCompletedText(candidate, ctx);
		streamingDoneCarry.set(update.contentIndex, candidate.slice(-32));
	});

	pi.on("message_end", async (event, ctx) => {
		applyCompletedSteps(event.message, ctx);
		if (isAssistantMessage(event.message)) streamingDoneCarry.clear();
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		applyCompletedSteps(event.message, ctx);
		persistState();

		if (!completionTransitionQueued && todoItems.every((item) => item.completed)) {
			completionTransitionQueued = true;
			const normalState = buildNormalState();
			pi.sendMessage(
				{ customType: normalState.customType, content: normalState.content, display: false },
				{ triggerTurn: false },
			);
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				pi.appendEntry<PlanCompleteData>("plan-complete", {
					items: todoItems.map((item) => item.text),
				});
				executionMode = false;
				todoItems = [];
				updateStatus(ctx);
				persistState();

				if (!completionTransitionQueued) {
					const normalState = buildNormalState();
					pi.sendMessage(
						{ customType: normalState.customType, content: normalState.content, display: false },
						{ triggerTurn: false },
					);
				}
				completionTransitionQueued = false;
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		if (lastAssistant) {
			const extracted = extractTodoItems(getTextContent(lastAssistant));
			if (extracted.length > 0) {
				todoItems = extracted;
			}
		}

		if (todoItems.length === 0) return;
		persistState();

		const todoListText = todoItems.map((t, i) => `${i + 1}. ○ ${t.text}`).join("\n");
		const planTodoListMessage = {
			customType: "plan-todo-list",
			content: `**Plan Steps (${todoItems.length}):**\n\n${todoListText}`,
			display: true,
		};

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
		]);

		if (choice?.startsWith("Execute")) {
			planModeEnabled = false;
			executionMode = true;
			completionTransitionQueued = false;
			updateStatus(ctx);
			persistState();

			const executionState = buildPlanState();
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: executionState.content, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) {
				pi.sendMessage(planTodoListMessage, { deliverAs: "followUp" });
				pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
			}
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		renderedStatus = undefined;
		renderedWidget = undefined;
		hasRenderedStatus = false;
		hasRenderedWidget = false;

		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		const entries = ctx.sessionManager.getBranch();

		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
		}

		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeCtx = undefined;
		unsubscribeInvalidate();
		publishStatus(ctx, undefined);
		publishWidget(ctx, undefined);
		renderedStatus = undefined;
		renderedWidget = undefined;
		hasRenderedStatus = false;
		hasRenderedWidget = false;
		streamingDoneCarry.clear();
	});
}
