import assert from "node:assert/strict";
import test from "node:test";
import { parseUsageCache } from "./cache.ts";

const report = [{
  provider: "codex",
  source: "oauth",
  usage: {
    primary: { usedPercent: 10, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10_080 },
    tertiary: null,
  },
}];

test("parses valid persistent usage reports independently", () => {
  const cache = parseUsageCache(JSON.stringify({
    version: 1,
    reports: {
      codex: { report, fetchedAt: 123 },
      broken: { report: { nope: true }, fetchedAt: 456 },
    },
  }));
  assert.deepEqual(cache, { codex: { report, fetchedAt: 123 } });
});

test("ignores unknown cache versions", () => {
  assert.deepEqual(parseUsageCache('{"version":2,"reports":{}}'), {});
});
