import assert from "node:assert/strict";
import test from "node:test";
import { emitFooterInvalidate, FOOTER_INVALIDATE_EVENT } from "./events.ts";

test("publishes the shared footer invalidation event", () => {
  const emitted: Array<[string, unknown]> = [];
  emitFooterInvalidate({
    emit(channel, data) {
      emitted.push([channel, data]);
    },
  });
  assert.deepEqual(emitted, [[FOOTER_INVALIDATE_EVENT, undefined]]);
});
