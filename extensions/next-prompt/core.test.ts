import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscript, isCompletedReply, parseConfig, parseSuggestion, SYSTEM_PROMPT } from "./core.ts";

const entry = (role: string, content: unknown, stopReason = "stop") => ({
  type: "message", message: { role, content, stopReason },
});

test("next-prompt is opt-in and defaults to GPT-6 Luna", () => {
  assert.equal(parseConfig(undefined), undefined);
  assert.equal(parseConfig({ enabled: false }), undefined);
  assert.deepEqual(parseConfig({ enabled: true }), {
    model: { provider: "openai-codex", id: "gpt-6-luna" },
  });
  assert.deepEqual(parseConfig({ enabled: true, model: { provider: "example", id: "fast" } }), {
    model: { provider: "example", id: "fast" },
  });
  assert.equal(parseConfig({ enabled: true, model: { id: "fast" } }), undefined);
  assert.equal(parseConfig({ enabled: true, model: { provider: "", id: "fast" } }), undefined);
});

test("accepts one short line, skips sentinel, empty, multiline and oversized replies", () => {
  assert.equal(parseSuggestion("  давай добавим тесты  "), "давай добавим тесты");
  assert.equal(parseSuggestion("Let's add tests."), "Let's add tests.");
  for (const text of ["", "  ", "NO_PREDICTION", '"NO_PREDICTION"', "first\nsecond", "x".repeat(241), "```run tests```"])
    assert.equal(parseSuggestion(text), undefined);
});

test("rejects terminal controls, invisible formatting and non-text model output", () => {
  for (const text of ["run\x1b[31m tests", "run\x07 tests", "run\rtests", "run\u009b31m tests", "run\u202etests", "\u200b"])
    assert.equal(parseSuggestion(text), undefined);
});

test("uses only recent visible user and assistant text, excluding tools and thinking", () => {
  const entries = [
    entry("system", "SECRET SYSTEM"),
    entry("user", [{ type: "text", text: "Please fix it" }, { type: "image", data: "SECRET IMAGE" }]),
    entry("assistant", [{ type: "thinking", thinking: "SECRET THINKING" }, { type: "toolCall", name: "read", arguments: { path: "SECRET PATH" } }]),
    entry("toolResult", "SECRET FILE"),
    entry("assistant", [{ type: "text", text: "Fixed. Tests pass." }]),
    { type: "custom", data: "SECRET CUSTOM" },
  ];
  const transcript = buildTranscript(entries);
  assert.deepEqual(JSON.parse(transcript), [
    { role: "user", text: "Please fix it" },
    { role: "assistant", text: "Fixed. Tests pass." },
  ]);
  assert.ok(!transcript.includes("SECRET"));
  assert.match(SYSTEM_PROMPT, /language/i);
  assert.match(SYSTEM_PROMPT, /NO_PREDICTION/);
});

test("bounds transcript size while retaining the latest reply", () => {
  const entries = Array.from({ length: 100 }, (_, i) => entry(i % 2 ? "assistant" : "user", `${i}: ${"x".repeat(5_000)}`));
  entries.push(entry("assistant", "LATEST REPLY"));
  const transcript = buildTranscript(entries);
  assert.ok(transcript.length <= 12_000);
  assert.ok(transcript.includes("LATEST REPLY"));
  assert.ok(!transcript.includes("0: "));
  assert.ok(JSON.parse(transcript).length <= 10);
});

test("only a final successful assistant reply qualifies", () => {
  for (const reason of ["aborted", "error", "length", "toolUse", "pending"])
    assert.equal(isCompletedReply([entry("assistant", "unfinished", reason)]), false);
  assert.equal(isCompletedReply([entry("assistant", "done"), { type: "custom" }]), true);
  assert.equal(isCompletedReply([entry("assistant", [{ type: "thinking", thinking: "no visible reply" }])]), false);
  assert.equal(isCompletedReply([entry("assistant", "done"), entry("user", "new request")]), false);
  assert.equal(isCompletedReply([]), false);
});
