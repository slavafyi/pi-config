import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { calculateSessionStats } from "./core.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const fixture = fileURLToPath(new URL("./fixtures/accounting.ts", import.meta.url));
const limit = fileURLToPath(new URL("../tool-output-limit/index.ts", import.meta.url));

for (const mode of ["direct", "parallel", "failed", "virtual"]) {
  test(`real Pi accounts ${mode} tool usage once and preserves physical model attribution`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-accounting-"));
    const path = join(directory, "session.jsonl");
    try {
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"], codemode: { mode: "on" } }));
      const child = exec(process.execPath, [cli, "--no-extensions", "-e", "builtin:codemode", "-e", fixture, "-e", limit,
        "--session", path, "--provider", mode === "virtual" ? "accounting-router" : "accounting-fixture",
        "--model", mode === "virtual" ? "auto" : "physical", "--thinking", "off", "--mode", "json", "-p", "Run the offline accounting fixture."], {
        cwd: directory, env: { ...process.env, HOME: directory, PI_CODING_AGENT_DIR: directory,
          PI_CONFIG_DIR: join(directory, "global"), ACCOUNTING_MODE: mode }, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      child.child.stdin?.end();
      const { stdout, stderr } = await child;
      assert.equal(stderr, "");
      assert.ok(stdout.includes("ACCOUNTING_COMPLETE"));
      const manager = SessionManager.open(path);
      const entries = manager.getEntries();
      const assistants = entries.flatMap(entry => entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []);
      assert.equal(assistants.length, 2);
      assert.ok(assistants.every(message => message.provider === "accounting-fixture" && message.model === "physical"));
      const toolResults = entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
      assert.equal(toolResults.length, 1, "nested calls must not create separate transcript results");
      const nestedCost = mode === "direct" || mode === "failed" ? 0.125 : 0.28125;
      assert.equal(toolResults[0]?.usage?.cost.total, nestedCost);
      assert.equal(toolResults[0]?.isError, mode === "failed");
      const before = calculateSessionStats(entries);
      assert.equal(before.cost, 0.5 + nestedCost);
      assert.equal(before.cacheHitPercent, 90);
      manager.appendUsage("cache_warm", "accounting-fixture", "physical", {
        input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
        cost: { input: 0.0625, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0625 },
      });
      const reopened = SessionManager.open(path);
      assert.equal(calculateSessionStats(reopened.getEntries()).cost, before.cost + 0.0625);
      assert.equal(calculateSessionStats(reopened.getEntries()).cacheHitPercent, 90);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
