import assert from "node:assert/strict";

import withAgents, {
  ACTIVE_MARKER,
  AGENT_GUARD_PROMPT,
  ORCHESTRATION_TOOLS,
  VALIDATOR_PROMPT,
} from "./index.ts";
import {
  arm,
  completeBackgroundAgent,
  consumeBackgroundNotification,
  consumeBackgroundResult,
  createState,
  formatContextUsage,
  noteBackgroundAgent,
  noteUserPrompt,
  reset,
  settleParentRun,
  startParentRun,
} from "./policy.ts";

const state = createState();

assert.equal(startParentRun(state), false);
assert.equal(arm(state), true);
assert.equal(arm(state), false);
assert.equal(noteUserPrompt(state, "extension"), false);
assert.equal(startParentRun(state), false);
assert.equal(noteUserPrompt(state, "interactive"), true);
assert.equal(startParentRun(state), true);
assert.equal(state.phase, "active");
assert.equal(noteUserPrompt(state, "interactive"), false);
assert.equal(settleParentRun(state), true);
assert.deepEqual(state, createState());

assert.equal(arm(state), true);
assert.equal(noteUserPrompt(state, "interactive"), true);
assert.equal(startParentRun(state), true);
assert.equal(noteBackgroundAgent(state, "background-1"), true);
assert.equal(settleParentRun(state), false);
assert.equal(completeBackgroundAgent(state, "background-1"), true);
assert.equal(settleParentRun(state), false);
assert.equal(consumeBackgroundNotification(state, ["background-1"]), true);
assert.equal(settleParentRun(state), true);
assert.deepEqual(state, createState());

assert.equal(arm(state), true);
assert.equal(noteUserPrompt(state, "interactive"), true);
assert.equal(startParentRun(state), true);
assert.equal(noteBackgroundAgent(state, "background-2"), true);
assert.equal(completeBackgroundAgent(state, "background-2"), true);
assert.equal(consumeBackgroundResult(state, "background-2"), true);
assert.equal(settleParentRun(state), true);
assert.deepEqual(state, createState());

assert.equal(arm(state), true);
assert.equal(noteUserPrompt(state, "rpc"), true);
assert.equal(startParentRun(state), true);
reset(state);
assert.deepEqual(state, createState());

assert.equal(formatContextUsage(undefined), undefined);
assert.equal(
  formatContextUsage({ tokens: 120_000, contextWindow: 200_000, percent: 60 }),
  "Parent context: 120,000/200,000 tokens used (60.0%); 80,000 tokens remain (40.0%).",
);
assert.equal(
  formatContextUsage({ tokens: null, contextWindow: 200_000, percent: null }),
  "Parent context: usage temporarily unknown after compaction; context window 200,000 tokens.",
);

const handlers = new Map<string, (event: any, ctx: any) => any>();
const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
const notifications: Array<{ message: string; type: string }> = [];
let activeTools = [...ORCHESTRATION_TOOLS, "read"];
let idle = true;
let contextUsage = { tokens: 120_000, contextWindow: 200_000, percent: 60 };
const pi = {
  on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
  events: { on: () => {} },
  registerCommand: (
    name: string,
    command: { handler: (args: string, ctx: any) => Promise<void> },
  ) => commands.set(name, command.handler),
  getAllTools: () => ORCHESTRATION_TOOLS.map((name) => ({ name })),
  getActiveTools: () => activeTools,
};
const ctx = {
  isIdle: () => idle,
  getContextUsage: () => contextUsage,
  ui: {
    notify: (message: string, type: string) => notifications.push({ message, type }),
  },
};

withAgents(pi as any);
handlers.get("session_start")?.({}, ctx);

const normalStart = handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
assert.equal(normalStart.systemPrompt, `base\n\n${AGENT_GUARD_PROMPT}`);
assert.equal(normalStart.systemPrompt.includes(VALIDATOR_PROMPT.trim()), false);
assert.equal(handlers.get("context")?.({ messages: [] }, ctx), undefined);
for (const toolName of ORCHESTRATION_TOOLS) {
  assert.deepEqual(handlers.get("tool_call")?.({ toolName }, ctx), {
    block: true,
    reason: "Run /with-agents before using subagent tools.",
  });
}

await commands.get("with-agents")?.("", ctx);
handlers.get("input")?.({ source: "interactive" }, ctx);
const activeStart = handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
assert.equal(activeStart.message.customType, "with-agents-policy");
assert.equal(activeStart.message.display, false);
assert.match(activeStart.message.content, new RegExp(ACTIVE_MARKER));
assert.match(activeStart.message.content, /Gate 1/);
assert.doesNotMatch(activeStart.message.content, /120,000\/200,000 tokens used/);

const stableMessages = [
  { role: "user", content: "task", timestamp: 1 },
  { role: "custom", ...activeStart.message, timestamp: 2 },
];
const firstContext = handlers.get("context")?.({ messages: stableMessages }, ctx);
assert.equal(stableMessages.length, 2);
assert.equal(firstContext.messages.length, 3);
assert.equal(firstContext.messages[2].customType, "with-agents-context-usage");
assert.match(firstContext.messages[2].content, /120,000\/200,000 tokens used/);

contextUsage = { tokens: 130_000, contextWindow: 200_000, percent: 65 };
const newTail = [
  { role: "assistant", content: "Calling a tool", timestamp: 3 },
  { role: "toolResult", content: "A short result", timestamp: 4 },
];
const secondContext = handlers.get("context")?.({ messages: [...stableMessages, ...newTail] }, ctx);
assert.deepEqual(secondContext.messages.slice(0, stableMessages.length), stableMessages);
assert.deepEqual(secondContext.messages.slice(stableMessages.length, -1), newTail);
assert.equal(secondContext.messages.at(-1).customType, "with-agents-context-usage");
assert.match(secondContext.messages.at(-1).content, /130,000\/200,000 tokens used/);
const freshTail = secondContext.messages.slice(stableMessages.length);
assert.deepEqual(
  freshTail.map((message: { role: string }) => message.role),
  ["assistant", "toolResult", "custom"],
);
if (process.env.WITH_AGENTS_CACHE_DIAGNOSTICS) {
  console.log(
    `with-agents fresh tail: ${freshTail.length} messages, ${JSON.stringify(freshTail).length} serialized characters`,
  );
}
for (const toolName of ORCHESTRATION_TOOLS) {
  assert.equal(handlers.get("tool_call")?.({ toolName }, ctx), undefined);
}

handlers.get("agent_settled")?.({}, ctx);
assert.equal(handlers.get("context")?.({ messages: [] }, ctx), undefined);
assert.deepEqual(handlers.get("tool_call")?.({ toolName: "Agent" }, ctx), {
  block: true,
  reason: "Run /with-agents before using subagent tools.",
});

idle = false;
await commands.get("with-agents")?.("", ctx);
assert.deepEqual(notifications.at(-1), {
  message: "Wait for the current parent run to finish, then run /with-agents again.",
  type: "warning",
});
handlers.get("input")?.({ source: "interactive" }, ctx);
handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
assert.equal(handlers.get("context")?.({ messages: [] }, ctx), undefined);
idle = true;

activeTools = ["read"];
await commands.get("with-agents")?.("", ctx);
assert.deepEqual(notifications.at(-1), {
  message:
    "Cannot enable agents: inactive Agent, get_subagent_result, steer_subagent. Enable them with /tools first.",
  type: "error",
});
handlers.get("input")?.({ source: "interactive" }, ctx);
handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
assert.equal(handlers.get("context")?.({ messages: [] }, ctx), undefined);
