import assert from "node:assert/strict";
import test from "node:test";

import type { TextContent } from "@earendil-works/pi-ai";
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

test("keeps UTF-8-safe head and tail windows and saves complete output", async () => {
  const original = `HEADER 🙂\n${"prefix\n".repeat(3000)}${"🙂".repeat(6000)}\nCommand exited with code 1`;
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
  assert.ok(output.startsWith("HEADER 🙂"));
  assert.ok(output.includes("[... middle omitted ...]"));
  assert.equal(output.includes("�"), false);
  assert.ok(output.includes("Command exited with code 1"));
  assert.ok(output.includes("showing first 2.0KB and last 8.0KB"));
  assert.ok(output.endsWith("Full output: /tmp/pi-bash-full.log]"));
  assert.equal(result.details.fullOutputPath, "/tmp/pi-bash-full.log");
  assert.equal(result.details.truncation?.maxBytes, 10 * 1024);
  const truncatedContent = result.details.truncation?.content ?? "";
  assert.equal(result.details.truncation?.outputBytes, Buffer.byteLength(truncatedContent));
  assert.ok(Buffer.byteLength(truncatedContent) <= 10 * 1024);
});

test("reuses Pi full output path and source totals", async () => {
  const original = Array.from({ length: 5000 }, (_, index) => `line ${index + 1} ${"x".repeat(20)}`).join("\n");
  const totalBytes = Buffer.byteLength(original);
  const piPath = "/tmp/pi-bash-existing.log";
  const piText = `line 4000\nline 5000\n\n[Showing lines 4000-5000 of 5000. Full output: ${piPath}]`;
  let saved = false;
  let requestedBytes: [number, number] | undefined;

  const result = await limitBashOutput({
    content: textContent(piText),
    details: {
      truncation: {
        content: "line 4000\nline 5000",
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 5000,
        totalBytes,
        outputLines: 2,
        outputBytes: 19,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2000,
        maxBytes: 50 * 1024,
      },
      fullOutputPath: piPath,
    },
    maxKiB: 20,
    saveFullOutput: async () => {
      saved = true;
      return "/tmp/unused";
    },
    readFullOutputWindows: async (path, headBytes, tailBytes) => {
      assert.equal(path, piPath);
      requestedBytes = [headBytes, tailBytes];
      return {
        head: Buffer.from(original).subarray(0, headBytes).toString(),
        tail: Buffer.from(original).subarray(-tailBytes).toString(),
        tailStartsMidLine: true,
      };
    },
  });

  assert.ok(result);
  assert.equal(saved, false);
  assert.deepEqual(requestedBytes, [4090, 16364]);
  assert.equal(result.details.fullOutputPath, piPath);
  assert.equal(result.details.truncation?.totalLines, 5000);
  assert.equal(result.details.truncation?.totalBytes, totalBytes);
  assert.equal(result.details.truncation?.outputBytes, 20 * 1024);
  assert.equal(result.details.truncation?.lastLinePartial, true);
  const output = outputText(result.content);
  assert.ok(output.startsWith("line 1 "));
  assert.ok(output.includes("[... middle omitted ...]"));
  assert.ok(output.includes("line 5000 "));
  assert.equal(output.match(/Full output:/g)?.length, 1);
  assert.ok(output.endsWith(`Full output: ${piPath}]`));
});

test("uses Pi source totals when its visible tail is below the configured limit", async () => {
  const original = `HEADER\n${"x".repeat(52 * 1024)}\nEND`;
  const piPath = "/tmp/pi-bash-long-line.log";
  const piBody = "END";
  const piText = `${piBody}\n\n[Showing lines 3-3 of 3. Full output: ${piPath}]`;
  const totalBytes = Buffer.byteLength(original);

  const result = await limitBashOutput({
    content: textContent(piText),
    details: {
      truncation: {
        content: piBody,
        truncated: true,
        truncatedBy: "bytes",
        totalLines: 3,
        totalBytes,
        outputLines: 1,
        outputBytes: Buffer.byteLength(piBody),
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2000,
        maxBytes: 50 * 1024,
      },
      fullOutputPath: piPath,
    },
    maxKiB: 20,
    saveFullOutput: async () => "/tmp/unused",
    readFullOutputWindows: async (_path, headBytes, tailBytes) => ({
      head: Buffer.from(original).subarray(0, headBytes).toString(),
      tail: Buffer.from(original).subarray(-tailBytes).toString(),
      tailStartsMidLine: true,
    }),
  });

  assert.ok(result);
  assert.equal(result.details.truncation?.maxBytes, 20 * 1024);
  assert.equal(result.details.truncation?.outputBytes, 20 * 1024);
  assert.equal(result.details.truncation?.totalBytes, totalBytes);
  const output = outputText(result.content);
  assert.ok(output.startsWith("HEADER\n"));
  assert.ok(output.includes("[... middle omitted ...]"));
  assert.ok(output.endsWith(`Full output: ${piPath}]`));
});

test("fills the tail window from a single long line", async () => {
  const original = `HEAD-${"🙂".repeat(8 * 1024)}-TAIL`;
  const result = await limitBashOutput({
    content: textContent(original),
    maxKiB: 10,
    saveFullOutput: async () => "/tmp/pi-bash-single-line.log",
  });

  assert.ok(result);
  assert.ok((result.details.truncation?.outputBytes ?? 0) >= 10 * 1024 - 6);
  assert.equal(result.details.truncation?.lastLinePartial, true);
  const output = outputText(result.content);
  assert.equal(output.includes("�"), false);
  assert.ok(output.includes("-TAIL"));
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
