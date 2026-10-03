import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  ExtensionRunner,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import planMode from "../plan-mode/index.ts";
import toolOutputLimit from "./index.ts";

// Exercise the pinned Pi sandbox implementation; it has no public SDK export.
const { executeCodemode } = await import(new URL(
  "./extensions/codemode/execute.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);

function createHarness(directory: string) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    events: { on: () => () => {} },
    registerFlag: () => {},
    getFlag: () => false,
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
  };
  toolOutputLimit(pi as any);
  planMode(pi as any);
  const sessionManager = SessionManager.inMemory();
  const runner = new ExtensionRunner(
    [{ path: "codemode-test", handlers } as any],
    {} as any,
    directory,
    sessionManager,
    {} as any,
  );
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  const tools = [
    createBashTool(directory), createReadTool(directory),
    createEditTool(directory), createWriteTool(directory),
  ];
  const calls: string[] = [];
  const outputPaths: string[] = [];
  let sequence = 0;
  const context = {
    sessionManager,
    tools,
    async executeTool(name: string, args: any, options: any) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const toolCall = { type: "toolCall", id: `script/${++sequence}`, name, arguments: args };
      const event = {
        toolName: name, toolCallId: toolCall.id, parentToolCallId: "script", input: args,
      };
      const blocked = await runner.emitToolCall({ type: "tool_call", ...event } as any);
      if (blocked?.block) {
        return {
          toolCall,
          result: { content: [{ type: "text", text: blocked.reason }], details: {} },
          isError: true,
        };
      }
      calls.push(name);
      const result = await tool.execute(toolCall.id, args, options.signal);
      const patch = await runner.emitToolResult({
        type: "tool_result", ...event, ...result, isError: false,
      } as any);
      assert.equal(patch, undefined, "nested data must not be limited");
      const path = (result.details as any)?.fullOutputPath;
      if (path) outputPaths.push(path);
      return { toolCall, result, isError: false };
    },
  };
  return { runner, context, commands, calls, errors, outputPaths };
}

async function withHarness(run: (harness: ReturnType<typeof createHarness>, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "pi-codemode-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  writeFileSync(join(directory, "user-settings.json"), JSON.stringify({
    extensions: { "tool-output-limit": { bash: 10, read: 10, grep: 10 } },
  }));
  const harness = createHarness(directory);
  try {
    await harness.runner.emit({ type: "session_start" } as any);
    await run(harness, directory);
    assert.deepEqual(harness.errors, []);
  } finally {
    for (const path of harness.outputPaths) rmSync(path, { force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("codemode filters large real bash and read results before returning output", async () => {
  await withHarness(async ({ context, calls }, directory) => {
    const data = Array.from({ length: 1000 }, (_, id) => ({ id, failed: id === 999, padding: "x".repeat(80) }));
    writeFileSync(join(directory, "data.json"), JSON.stringify(data));
    writeFileSync(join(directory, "read-data.json"), JSON.stringify(data.slice(800)));
    const result = await executeCodemode("script", { code: `
      const bash = await tools.bash({ command: "cat data.json" });
      const read = await tools.read({ path: "read-data.json" });
      text(JSON.parse(bash.output).filter(item => item.failed).map(item => item.id));
      text(JSON.parse(read).filter(item => item.failed).map(item => item.id));
    ` }, undefined, undefined, context);
    const text = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
    assert.equal(result.isError, undefined, text);
    assert.ok(text.includes("[999]"), text);
    assert.equal(text.split("[999]").length - 1, 2, text);
    assert.deepEqual(calls, ["bash", "read"]);
    assert.ok(text.length < 1024);
  });
});

test("codemode keeps its native final-output truncation and full-output file", async () => {
  await withHarness(async ({ context, runner, outputPaths }) => {
    const result = await executeCodemode("script", {
      code: '// @options: {"max_output_tokens": 100}\ntext("x".repeat(20000));',
    }, undefined, undefined, context);
    const path = result.details.fullOutputPath;
    assert.ok(path);
    outputPaths.push(path);
    assert.equal(readFileSync(path, "utf8"), "x".repeat(20000));
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.ok(text.includes("truncated output"));
    assert.ok(text.length < 2000);
    const patch = await runner.emitToolResult({
      type: "tool_result", toolName: "codemode", toolCallId: "script",
      input: {}, ...result, isError: false,
    } as any);
    assert.equal(patch, undefined);
  });
});

test("plan mode blocks nested mutations while allowing read-only codemode calls", async () => {
  await withHarness(async ({ context, runner, commands, calls }, directory) => {
    writeFileSync(join(directory, "existing.txt"), "original");
    await commands.get("plan").handler("", {
      ui: {
        notify: () => {}, setStatus: () => {}, setWidget: () => {},
        theme: { fg: (_tone: string, text: string) => text },
      },
    });
    const result = await executeCodemode("script", { code: `
      const outcomes = await Promise.allSettled([
        tools.write({ path: "new.txt", content: "changed" }),
        tools.edit({ path: "existing.txt", oldText: "original", newText: "changed" }),
        tools.bash({ command: "touch forbidden.txt" }),
        tools.read({ path: "existing.txt" }),
        tools.bash({ command: "cat existing.txt" }),
      ]);
      text(outcomes.map(outcome => outcome.status));
    ` }, undefined, undefined, context);
    const text = result.content.map((block: any) => block.text).join("\n");
    assert.equal(result.isError, undefined, text);
    assert.ok(text.includes('["rejected","rejected","rejected","fulfilled","fulfilled"]'), text);
    assert.deepEqual(calls.sort(), ["bash", "read"]);
    assert.equal(readFileSync(join(directory, "existing.txt"), "utf8"), "original");
    assert.throws(() => readFileSync(join(directory, "new.txt")), { code: "ENOENT" });
    assert.throws(() => readFileSync(join(directory, "forbidden.txt")), { code: "ENOENT" });
  });
});
