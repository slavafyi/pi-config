import assert from "node:assert/strict";

import {
  arm,
  createState,
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
