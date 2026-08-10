import assert from "node:assert/strict";

import {
  arm,
  createState,
  formatContextUsage,
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
