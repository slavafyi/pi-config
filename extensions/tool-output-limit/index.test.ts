import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import toolOutputLimit from "./index.ts";

function createPi() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  return {
    handlers,
    pi: {
      on: (event: string, handler: (event: any, ctx?: any) => any) => {
        handlers.set(event, handler);
      },
    },
  };
}

function writeSettings(directory: string, config: Record<string, number>): void {
  writeFileSync(
    join(directory, "user-settings.json"),
    JSON.stringify({ extensions: { "tool-output-limit": config } }),
  );
}

test("does nothing without explicit user configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const { handlers, pi } = createPi();
    toolOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const result = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(30 * 1024) }],
    });
    assert.equal(result, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not load the removed bash-output-limit setting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(
    join(directory, "user-settings.json"),
    JSON.stringify({ extensions: { "bash-output-limit": { maxKiB: 10 } } }),
  );

  try {
    const { handlers, pi } = createPi();
    toolOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const result = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [{ type: "text", text: "x".repeat(30 * 1024) }],
    });
    assert.equal(result, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rebuilds configured bash windows from Pi output with a long line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const fullOutputPath = join(tmpdir(), `pi-bash-long-line-${process.pid}.log`);
  process.env.PI_CODING_AGENT_DIR = directory;
  writeSettings(directory, { bash: 10 });
  const output = `HEADER\n${"🙂".repeat(14 * 1024)}\nEND`;
  writeFileSync(fullOutputPath, output);

  try {
    const { handlers, pi } = createPi();
    toolOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const result = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [
        {
          type: "text",
          text: `END\n\n[Showing lines 3-3 of 3. Full output: ${fullOutputPath}]`,
        },
      ],
      details: {
        truncation: {
          content: "END",
          truncated: true,
          truncatedBy: "bytes",
          totalLines: 3,
          totalBytes: Buffer.byteLength(output),
          outputLines: 1,
          outputBytes: 3,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2000,
          maxBytes: 50 * 1024,
        },
        fullOutputPath,
      },
    });

    assert.ok(result);
    assert.equal(result.details.truncation.maxBytes, 10 * 1024);
    assert.ok(result.details.truncation.outputBytes >= 10 * 1024 - 6);
    assert.equal(result.content[0].text.includes("�"), false);
    assert.ok(result.content[0].text.startsWith("HEADER\n"));
    assert.ok(result.content[0].text.endsWith(`Full output: ${fullOutputPath}]`));
  } finally {
    rmSync(fullOutputPath, { force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("applies independent limits to bash, grep, and read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeSettings(directory, { bash: 10, grep: 10, read: 10 });

  let fullOutputPath: string | undefined;
  try {
    const { handlers, pi } = createPi();
    toolOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const output = "x\n".repeat(15 * 1024);

    const bashResult = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [{ type: "text", text: output }],
    });
    assert.ok(bashResult);
    fullOutputPath = bashResult.details.fullOutputPath;
    assert.equal(readFileSync(fullOutputPath as string, "utf8"), output);

    const grepResult = await handlers.get("tool_result")?.({
      toolName: "grep",
      content: [{ type: "text", text: output }],
      details: { matchLimitReached: 100 },
    });
    assert.ok(grepResult);
    assert.equal(grepResult.details.truncation.maxBytes, 10 * 1024);

    const readResult = await handlers.get("tool_result")?.({
      toolName: "read",
      input: { path: "/tmp/example.txt" },
      content: [{ type: "text", text: output }],
    });
    assert.ok(readResult);
    assert.ok(readResult.content[0].text.includes("offset="));
  } finally {
    if (fullOutputPath) rmSync(fullOutputPath, { force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ignores tools without a configured limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-tool-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeSettings(directory, { grep: 10 });

  try {
    const { handlers, pi } = createPi();
    toolOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const output = "x".repeat(30 * 1024);

    const bashResult = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [{ type: "text", text: output }],
    });
    const readResult = await handlers.get("tool_result")?.({
      toolName: "read",
      input: { path: "/tmp/example.txt" },
      content: [{ type: "text", text: output }],
    });

    assert.equal(bashResult, undefined);
    assert.equal(readResult, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
