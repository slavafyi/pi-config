import assert from "node:assert/strict";
import test from "node:test";

import type { TextContent } from "@earendil-works/pi-ai";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import {
  limitBashOutput,
  parseBashOutputLimitConfig,
} from "./core.ts";

const textContent = (text: string): TextContent[] => [{ type: "text", text }];
const outputText = (content: Array<TextContent | { type: string }>): string => {
  const block = content.find((candidate): candidate is TextContent => candidate.type === "text");
  return block?.text ?? "";
};

test("requires an explicit supported maxKiB", () => {
  assert.equal(parseBashOutputLimitConfig(undefined), undefined);
  assert.equal(parseBashOutputLimitConfig({}), undefined);
  assert.equal(parseBashOutputLimitConfig({ maxKiB: "20" }), undefined);
  assert.equal(parseBashOutputLimitConfig({ maxKiB: 15 }), undefined);
  assert.equal(parseBashOutputLimitConfig({ maxKiB: 20.5 }), undefined);

  for (const maxKiB of [10, 20, 30, 40, 50]) {
    assert.deepEqual(parseBashOutputLimitConfig({ maxKiB }), { maxKiB });
  }
});

test("leaves output within the limit unchanged", async () => {
  let saved = false;
  const result = await limitBashOutput({
    content: textContent("small output"),
    maxKiB: 20,
    saveFullOutput: async () => {
      saved = true;
      return "/tmp/output";
    },
  });

  assert.equal(result, undefined);
  assert.equal(saved, false);
});

test("treats 50 KiB as native Pi behavior", async () => {
  let saved = false;
  const result = await limitBashOutput({
    content: textContent("x".repeat(60 * 1024)),
    maxKiB: 50,
    saveFullOutput: async () => {
      saved = true;
      return "/tmp/output";
    },
  });

  assert.equal(result, undefined);
  assert.equal(saved, false);
});

test("keeps a UTF-8-safe tail and saves complete output", async () => {
  const original = `${"prefix\n".repeat(3000)}${"🙂".repeat(6000)}\nCommand exited with code 1`;
  let savedOutput: string | undefined;
  const result = await limitBashOutput({
    content: textContent(original),
    maxKiB: 10,
    saveFullOutput: async (output) => {
      savedOutput = output;
      return "/tmp/pi-bash-full.log";
    },
  });

  assert.ok(result);
  assert.equal(savedOutput, original);
  const output = outputText(result.content);
  const body = output.slice(0, output.lastIndexOf("\n\n[Showing lines"));
  assert.ok(Buffer.byteLength(body, "utf8") <= 10 * 1024);
  assert.equal(body.includes("�"), false);
  assert.ok(body.endsWith("Command exited with code 1"));
  assert.ok(output.endsWith("Full output: /tmp/pi-bash-full.log]"));
  assert.equal(result.details.fullOutputPath, "/tmp/pi-bash-full.log");
  assert.equal(result.details.truncation?.maxBytes, 10 * 1024);
});

test("reuses Pi full output path and source totals", async () => {
  const original = Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`).join("\n");
  const piTruncation = truncateTail(original, { maxBytes: 50 * 1024, maxLines: 2000 });
  const piPath = "/tmp/pi-bash-existing.log";
  const piText = `${piTruncation.content}\n\n[Showing lines 3001-5000 of 5000. Full output: ${piPath}]`;
  let saved = false;

  const result = await limitBashOutput({
    content: textContent(piText),
    details: { truncation: piTruncation, fullOutputPath: piPath },
    maxKiB: 20,
    saveFullOutput: async () => {
      saved = true;
      return "/tmp/unused";
    },
  });

  assert.ok(result);
  assert.equal(saved, false);
  assert.equal(result.details.fullOutputPath, piPath);
  assert.equal(result.details.truncation?.totalLines, piTruncation.totalLines);
  assert.equal(result.details.truncation?.totalBytes, piTruncation.totalBytes);
  const output = outputText(result.content);
  assert.equal(output.match(/Full output:/g)?.length, 1);
  assert.ok(output.endsWith(`Full output: ${piPath}]`));
});

test("keeps original output when full output cannot be saved", async () => {
  const original = "x".repeat(30 * 1024);
  const result = await limitBashOutput({
    content: textContent(original),
    maxKiB: 20,
    saveFullOutput: async () => {
      throw new Error("disk full");
    },
  });

  assert.equal(result, undefined);
});

test("ignores results without text content", async () => {
  const result = await limitBashOutput({
    content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    maxKiB: 20,
    saveFullOutput: async () => "/tmp/output",
  });

  assert.equal(result, undefined);
});
