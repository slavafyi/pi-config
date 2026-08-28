import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import bashOutputLimit from "./index.ts";

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

test("does nothing without explicit user configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-bash-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const { handlers, pi } = createPi();
    bashOutputLimit(pi as any);
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

test("limits configured bash results and ignores other tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-bash-output-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(
    join(directory, "user-settings.json"),
    JSON.stringify({ extensions: { "bash-output-limit": { maxKiB: 20 } } }),
  );

  let fullOutputPath: string | undefined;
  try {
    const { handlers, pi } = createPi();
    bashOutputLimit(pi as any);
    handlers.get("session_start")?.({});
    const output = "x".repeat(30 * 1024);

    const ignored = await handlers.get("tool_result")?.({
      toolName: "read",
      content: [{ type: "text", text: output }],
    });
    assert.equal(ignored, undefined);

    const result = await handlers.get("tool_result")?.({
      toolName: "bash",
      content: [{ type: "text", text: output }],
    });
    assert.ok(result);
    const path = result.details.fullOutputPath;
    assert.equal(typeof path, "string");
    fullOutputPath = path;
    assert.equal(readFileSync(path as string, "utf8"), output);
  } finally {
    if (fullOutputPath) rmSync(fullOutputPath, { force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
