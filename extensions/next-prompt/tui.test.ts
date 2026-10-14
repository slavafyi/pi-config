import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const fixture = fileURLToPath(new URL("./fixtures/tui.ts", import.meta.url));
const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
const footer = fileURLToPath(new URL("../footer/index.ts", import.meta.url));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { hasTmux = false; }

test("real Pi TUI: ghost, Tab/Right, Enter, dismissal, autocomplete, resize and reload", { skip: !hasTmux, timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-next-prompt-tui-"));
  const socket = `pi-next-prompt-test-${process.pid}`;
  const tmux = async (...args: string[]) => (await exec("tmux", ["-L", socket, ...args], { timeout: 10_000 })).stdout;
  t.after(async () => {
    await tmux("kill-server").catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  });

  for (const [mode, hardware, language, acceptKey] of [
    ["regular", false, "en", "Tab"], ["regular", true, "ru", "Right"],
    ["fullscreen", false, "ru", "Right"], ["fullscreen", true, "en", "Tab"],
  ] as const) {
    const name = `${mode}-${hardware ? "hardware" : "fake"}`;
    const cwd = join(directory, name);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cwd);
    const log = join(cwd, "events.jsonl");
    writeFileSync(join(cwd, "settings.json"), JSON.stringify({
      tuiMode: mode, showHardwareCursor: hardware, editorPaddingX: 1, quietStartup: true, theme: "dark",
    }));
    writeFileSync(join(cwd, "user-settings.json"), JSON.stringify({ extensions: {
      "next-prompt": { enabled: true, model: { provider: "next-prompt-fixture", id: "suggestion" } },
    } }));
    const command = ["exec", "env", `PI_CODING_AGENT_DIR=${quote(cwd)}`, `PI_CONFIG_DIR=${quote(join(cwd, "config"))}`,
      `NEXT_PROMPT_SMOKE_LOG=${quote(log)}`, `NEXT_PROMPT_SMOKE_LANGUAGE=${language}`,
      quote(process.execPath), quote(cli), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "-e", quote(fixture), "-e", quote(footer), "-e", quote(extension),
      "--provider", "next-prompt-fixture", "--model", "main", "--thinking", "off", "--session", quote(join(cwd, "session.jsonl")),
    ].join(" ");
    await tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24", "-c", cwd, command);
    const pane = () => tmux("capture-pane", "-p", "-t", name);
    const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const inputs = () => events().filter((event) => event.kind === "input");
    const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`${name}: ${label}\n${await pane().catch(() => "pane exited")}`);
    };
    const send = (...keys: string[]) => tmux("send-keys", "-t", name, ...keys);
    const type = (text: string) => tmux("send-keys", "-t", name, "-l", text);
    const suggestion = language === "ru" ? "давай добавим тесты" : "Let's add tests.";

    await waitFor(async () => (await pane()).includes("main"), "startup");
    await type(language === "ru" ? "проверь тесты" : "check tests"); await send("Enter");
    await waitFor(async () => (await pane()).includes(suggestion), "ghost suggestion");
    assert.equal(inputs().length, 1);
    assert.equal(events().filter((event) => event.kind === "request" && event.model === "suggestion").length, 1);

    await tmux("resize-window", "-t", name, "-x", "24", "-y", "20");
    await waitFor(async () => (await pane()).includes(language === "ru" ? "давай" : "Let's"), "narrow ghost");
    await tmux("resize-window", "-t", name, "-x", "80", "-y", "24");
    await waitFor(async () => (await pane()).includes(suggestion), "resize restore");

    await send("Enter"); // Empty input must not submit the ghost.
    await waitFor(async () => !(await pane()).includes(suggestion), "Enter dismisses unaccepted ghost");
    assert.equal(inputs().length, 1);
    await type("check again"); await send("Enter");
    await waitFor(async () => (await pane()).includes(suggestion), "second ghost");
    await send(acceptKey);
    assert.equal(inputs().length, 2, `${acceptKey} must not send`);
    await send("Enter");
    await waitFor(() => inputs().length === 3, "accepted prompt submitted separately");
    assert.equal(inputs()[2].text, suggestion);

    await waitFor(async () => (await pane()).split("\n").some((line) => /^\s+/.test(line) && line.includes(suggestion)), "third ghost");
    await type("/mod");
    await waitFor(async () => (await pane()).includes("/model"), "slash autocomplete");
    await send("Tab");
    assert.equal(inputs().length, 3);
    await send("C-c");
    await type("/reload"); await send("Enter");
    await waitFor(async () => (await pane()).toLowerCase().includes("reload"), "reload feedback");
    await type("after reload"); await send("Enter");
    await waitFor(() => inputs().some((event) => event.text === "after reload"), "input after reload");
    await waitFor(async () => (await pane()).includes(suggestion), "ghost after reload");
    await send("Escape");
    const journal = readFileSync(join(cwd, "session.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const usage = journal.filter((entry) => entry.type === "custom" && entry.customType === "next-prompt-usage");
    assert.ok(usage.length >= 3);
    assert.ok(usage.every((entry) => entry.data.model === "suggestion" && !JSON.stringify(entry.data).includes(suggestion)));
    await tmux("kill-session", "-t", name);
  }
});
