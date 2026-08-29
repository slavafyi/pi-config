import assert from "node:assert/strict";

import subagentPolicy, { formatContextUsage, SUBAGENT_POLICY_PROMPT } from "./index.ts";

assert.equal(formatContextUsage(undefined), undefined);
assert.equal(
  formatContextUsage({ tokens: 120_000, contextWindow: 200_000, percent: 60 }),
  "Parent context: 120,000/200,000 tokens used (60.0%); 80,000 tokens remain (40.0%).",
);
assert.equal(
  formatContextUsage({ tokens: null, contextWindow: 200_000, percent: null }),
  "Parent context: usage temporarily unknown after compaction; context window 200,000 tokens.",
);

assert.match(SUBAGENT_POLICY_PROMPT, /Calling Agent certifies that all three gates passed/);
assert.match(SUBAGENT_POLICY_PROMPT, /Use foreground agents when their result is required/);
assert.match(
  SUBAGENT_POLICY_PROMPT,
  /Use background agents only for long-running or genuinely independent work/,
);
assert.match(SUBAGENT_POLICY_PROMPT, /do not research, implement, plan, review/);
assert.match(
  SUBAGENT_POLICY_PROMPT,
  /Do not finalize while a required background result remains uncollected/,
);
assert.match(
  SUBAGENT_POLICY_PROMPT,
  /Any change after a reviewer examines an artifact invalidates that verdict/,
);
assert.match(SUBAGENT_POLICY_PROMPT, /Parallel writers must use separate git worktrees/);
assert.doesNotMatch(SUBAGENT_POLICY_PROMPT, /Prefer background agents for parallel fan-out/);

const handlers = new Map<string, (event: any, ctx: any) => any>();
const commands: string[] = [];
let contextUsage = { tokens: 120_000, contextWindow: 200_000, percent: 60 };
const pi = {
  on: (event: string, handler: (event: any, ctx: any) => any) => handlers.set(event, handler),
  registerCommand: (name: string) => commands.push(name),
};
const ctx = {
  getContextUsage: () => contextUsage,
};

subagentPolicy(pi as any);
assert.deepEqual(commands, []);
assert.deepEqual([...handlers.keys()].sort(), ["before_agent_start", "context"]);
assert.equal(handlers.has("tool_call"), false);

const firstStart = handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
const secondStart = handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx);
assert.equal(firstStart.systemPrompt, `base\n\n${SUBAGENT_POLICY_PROMPT}`);
assert.equal(secondStart.systemPrompt, firstStart.systemPrompt);
assert.doesNotMatch(firstStart.systemPrompt, /120,000\/200,000 tokens used/);

const stableMessages = [{ role: "user", content: "task", timestamp: 1 }];
const firstContext = handlers.get("context")?.({ messages: stableMessages }, ctx);
assert.equal(stableMessages.length, 1);
assert.equal(firstContext.messages.length, 2);
assert.equal(firstContext.messages[1].customType, "subagent-policy-context-usage");
assert.match(firstContext.messages[1].content, /120,000\/200,000 tokens used/);

contextUsage = { tokens: 130_000, contextWindow: 200_000, percent: 65 };
const newTail = [
  { role: "assistant", content: "Calling a tool", timestamp: 2 },
  { role: "toolResult", content: "A short result", timestamp: 3 },
];
const secondContext = handlers.get("context")?.({ messages: [...stableMessages, ...newTail] }, ctx);
assert.deepEqual(secondContext.messages.slice(0, stableMessages.length), stableMessages);
assert.deepEqual(secondContext.messages.slice(stableMessages.length, -1), newTail);
assert.equal(secondContext.messages.at(-1).customType, "subagent-policy-context-usage");
assert.match(secondContext.messages.at(-1).content, /130,000\/200,000 tokens used/);
assert.deepEqual(
  secondContext.messages
    .slice(stableMessages.length)
    .map((message: { role: string }) => message.role),
  ["assistant", "toolResult", "custom"],
);
