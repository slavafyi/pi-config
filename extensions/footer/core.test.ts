import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateSessionStats,
  classifyStatuses,
  normalizeAgents,
  normalizeKnownStatuses,
  parseFooterConfig,
  projectLabel,
  projectName,
  renderEditorTopBorder,
  renderFooter,
  sanitizeStatus,
  stripAnsi,
  subscribeToBranchChanges,
  type EditorBorderInput,
  type FooterLayoutInput,
  type FooterRole,
  type WidthTools,
} from "./core.ts";

function cellWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0xfe0e || code === 0xfe0f) return 0;
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) ? 2 : 1;
}

const tools: WidthTools = {
  visibleWidth(text) {
    return [...stripAnsi(text)].reduce((width, character) => width + cellWidth(character), 0);
  },
  truncateToWidth(text, width) {
    if (width <= 0) return "";
    let result = "";
    let used = 0;
    for (let index = 0; index < text.length;) {
      if (text[index] === "\x1b") {
        const match = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (match) {
          result += match[0];
          index += match[0].length;
          continue;
        }
      }
      const code = text.codePointAt(index);
      if (code === undefined) break;
      const character = String.fromCodePoint(code);
      const cells = cellWidth(character);
      if (used + cells > width) break;
      result += character;
      used += cells;
      index += character.length;
    }
    return result;
  },
};

function input(overrides: Partial<FooterLayoutInput> = {}): FooterLayoutInput {
  return {
    statuses: {
      usage: "7d:94% ↺5d13h",
      mcp: "MCP:0/2",
      agents: "agents:2",
      plan: "⏸︎ plan",
      mcpError: false,
      agentsActive: true,
      planActive: true,
    },
    metrics: {
      quota: "7d:94% ↺5d13h",
      cacheHitPercent: 98.1,
      context: { tokens: 32_640, contextWindow: 272_000, percent: 12 },
      cost: 1.134,
    },
    unknown: [],
    ...overrides,
  };
}

function editorInput(overrides: Partial<EditorBorderInput> = {}): EditorBorderInput {
  return {
    project: "pi-config",
    branch: "main",
    inGit: true,
    inTmux: false,
    model: "gpt-5.6-sol:fast",
    thinking: "medium",
    ...overrides,
  };
}

function assertWidths(lines: string[], width: number) {
  for (const line of lines) assert.ok(tools.visibleWidth(line) <= width, `${tools.visibleWidth(line)} > ${width}: ${line}`);
}

test("builds Git and non-Git labels inside and outside tmux", () => {
  assert.equal(projectName("/work/pi-config\n", "/fallback"), "pi-config");
  assert.equal(projectName(undefined, "/work/folder"), "folder");
  assert.equal(projectLabel({ project: "pi-config", branch: "main", inGit: true, inTmux: false }), "pi-config:main");
  assert.equal(projectLabel({ project: undefined, branch: "main", inGit: true, inTmux: false }), "main");
  assert.equal(projectLabel({ project: "folder", branch: null, inGit: false, inTmux: false }), "folder");
  assert.equal(projectLabel({ project: "pi-config", branch: "main", inGit: true, inTmux: true }), "main");
  assert.equal(projectLabel({ project: "pi-config", branch: "detached", inGit: true, inTmux: true }), "HEAD");
  assert.equal(projectLabel({ project: "folder", branch: null, inGit: false, inTmux: true }), undefined);
  assert.equal(projectLabel({ project: "pi-config", branch: "detached", inGit: true, inTmux: false }), "pi-config:HEAD");
});

test("classifies fixed status slots independently of Map order", () => {
  const classified = classifyStatuses(new Map([
    ["z-extra", "extra"],
    ["plan-mode", "\x1b[33m⏸︎ plan\x1b[0m"],
    ["usage", "5h:88% left (↺in 2h)  7d:94% left (↺in 5d13h)"],
    ["mcp", "🔌 MCP: 0/2"],
    ["subagents", "2 running agents, 1 queued"],
  ]));
  const known = normalizeKnownStatuses(classified.known);
  assert.deepEqual(classified.unknown, ["extra"]);
  assert.equal(known.usage, "5h:88% ↺2h  7d:94% ↺5d13h");
  assert.equal(known.mcp, "MCP:0/2");
  assert.equal(known.agents, "agents:2+1q");
  assert.equal(known.plan, "⏸︎ plan");
});

test("parses every footer status shape emitted by pi-subagents", () => {
  const cases = [
    ["1 running agent", "agents:1", 1, 0],
    ["2 running agents", "agents:2", 2, 0],
    ["1 queued agent", "agents:0+1q", 0, 1],
    ["2 queued agents", "agents:0+2q", 0, 2],
    ["1 running, 1 queued agents", "agents:1+1q", 1, 1],
    ["2 running, 1 queued agents", "agents:2+1q", 2, 1],
    ["1 running, 2 queued agents", "agents:1+2q", 1, 2],
  ] as const;

  for (const [raw, text, running, queued] of cases) {
    assert.deepEqual(normalizeAgents(raw), {
      text,
      running,
      queued,
      active: true,
    });
  }
  assert.deepEqual(normalizeAgents(undefined), { active: false });
  assert.deepEqual(normalizeAgents("agent manager error"), {
    text: "agent manager error",
    active: true,
  });
});

test("sanitizes unknown statuses and emits only a non-empty second line", () => {
  assert.equal(sanitizeStatus(" one\n\ttwo\r three "), "one two three");
  const classified = classifyStatuses(new Map([
    ["other", "one\n\ttwo"],
    ["empty", "\n\t"],
  ]));
  const hidden = renderFooter(input({ unknown: classified.unknown }), 180, tools);
  assert.equal(hidden.length, 1);

  const lines = renderFooter(
    input({ unknown: classified.unknown, showUnknownStatuses: true }),
    180,
    tools,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "one two");
  assert.equal(renderFooter(input(), 180, tools).length, 1);
});

test("defaults unknown extension statuses off and parses an explicit opt-in", () => {
  assert.deepEqual(parseFooterConfig(undefined), { showUnknownStatuses: false });
  assert.deepEqual(parseFooterConfig({}), { showUnknownStatuses: false });
  assert.deepEqual(parseFooterConfig({ showUnknownStatuses: "yes" }), {
    showUnknownStatuses: false,
  });
  assert.deepEqual(parseFooterConfig({ showUnknownStatuses: true }), {
    showUnknownStatuses: true,
  });
});

test("calculates full cost and the latest assistant cache hit", () => {
  const usage = (cacheRead: number, cost: number) => ({
    input: 10,
    output: 3,
    cacheRead,
    cacheWrite: 5,
    cost: { total: cost },
  });
  const stats = calculateSessionStats([
    { type: "message", message: { role: "assistant", usage: usage(85, 0.5) } },
    { type: "message", message: { role: "toolResult", usage: usage(0, 0.1) } },
    { type: "compaction", usage: usage(0, 0.2) },
    { type: "branch_summary", usage: usage(0, 0.3) },
    { type: "message", message: { role: "assistant", usage: usage(45, 0.034) } },
  ]);
  assert.ok(Math.abs(stats.cost - 1.134) < 1e-12);
  assert.equal(stats.cacheHitPercent, 75);
});

test("renders wide, compact, narrow, and minimal layouts by measured width", () => {
  const wide = renderFooter(input(), 180, tools);
  assert.match(wide[0]!, /^7d:94% ↺5d13h  MCP:0\/2  agents:2  ⏸︎ plan\s+/);
  assert.ok(wide[0]!.endsWith("cache:98.1%  ctx:12%/272k  $1.134"));

  const compact = renderFooter(input(), 62, tools);
  assert.match(compact[0]!, /A(?::)?2/);
  assertWidths(compact, 62);

  const narrow = renderFooter(input(), 72, tools);
  assert.match(narrow[0]!, /⏸/);
  assertWidths(narrow, 72);

  const minimal = renderFooter(input(), 24, tools);
  assertWidths(minimal, 24);
  assert.notEqual(minimal[0], "");
});

test("renders project and model metadata in the editor top border", () => {
  const wide = renderEditorTopBorder(editorInput(), 80, tools, (text) => text);
  assert.match(wide, /^─ pi-config:main ─+/);
  assert.ok(wide.endsWith(" gpt-5.6-sol:fast/medium ─"));
  assert.equal(tools.visibleWidth(wide), 80);

  const tmux = renderEditorTopBorder(
    editorInput({ inTmux: true }),
    62,
    tools,
    (text) => text,
  );
  assert.match(tmux, /^─ main ─+/);
  assert.ok(tmux.endsWith(" gpt-5.6-sol:fast/medium ─"));
  assert.equal(tools.visibleWidth(tmux), 62);

  const compact = renderEditorTopBorder(editorInput(), 24, tools, (text) => text);
  assert.match(compact, /5\.6\/m/);
  assert.equal(tools.visibleWidth(compact), 24);

  for (const width of [1, 2, 5, 12, 24]) {
    assert.equal(
      tools.visibleWidth(renderEditorTopBorder(editorInput(), width, tools, (text) => text)),
      width,
    );
  }
});

test("preserves owned extension colors inside the responsive layout", () => {
  const quotaStyled =
    "\x1b[2m7d:\x1b[0m\x1b[36m94%\x1b[0m\x1b[2m ↺5d13h\x1b[0m";
  const planStyled = "\x1b[33m⏸︎ plan\x1b[0m";
  const owned = input({
    statuses: {
      ...input().statuses,
      usageStyled: quotaStyled,
      planStyled,
    },
    metrics: {
      ...input().metrics,
      quotaStyled,
    },
    style(text) {
      return `\x1b[2m${text}\x1b[0m`;
    },
  });

  const wide = renderFooter(owned, 180, tools);
  assert.ok(wide[0]!.includes(quotaStyled));
  assert.ok(wide[0]!.includes(planStyled));
  assertWidths(wide, 180);

  for (const width of [110, 72, 30]) {
    assertWidths(renderFooter(owned, width, tools), width);
  }
});

test("colors only the context percentage at warning thresholds", () => {
  const colored = renderFooter(
    input({
      metrics: {
        ...input().metrics,
        context: { tokens: 250_000, contextWindow: 272_000, percent: 92 },
      },
      style(text, role) {
        const color = role === "error" ? 31 : role === "warning" ? 33 : 2;
        return `\x1b[${color}m${text}\x1b[0m`;
      },
    }),
    180,
    tools,
  );
  assert.ok(
    colored[0]!.includes(
      "\x1b[2mctx:\x1b[0m\x1b[31m92%\x1b[0m\x1b[2m/272k\x1b[0m",
    ),
  );
});

test("colors running and queued agent counts independently", () => {
  const colored = input({
    statuses: {
      ...input().statuses,
      agents: "agents:2+1q",
      agentsRunning: 2,
      agentsQueued: 1,
    },
    style(text, role) {
      const color = role === "agent-running" ? 36 : role === "agent-queued" ? 33 : 2;
      return `\x1b[${color}m${text}\x1b[0m`;
    },
  });
  const wide = renderFooter(colored, 180, tools);
  assert.ok(
    wide[0]!.includes(
      "\x1b[2magents:\x1b[0m\x1b[36m2\x1b[0m\x1b[33m+1q\x1b[0m",
    ),
  );
  for (const width of [180, 110, 72, 30]) {
    assertWidths(renderFooter(colored, width, tools), width);
  }
});

test("applies semantic colors after responsive selection", () => {
  const roles = new Set<FooterRole>();
  const colored = renderFooter(
    input({
      style(text, role) {
        roles.add(role);
        return `\x1b[36m${text}\x1b[0m`;
      },
    }),
    180,
    tools,
  );
  const plain = renderFooter(input(), 180, tools);
  const editor = renderEditorTopBorder(
    editorInput({
      style(text, role) {
        roles.add(role);
        return `\x1b[36m${text}\x1b[0m`;
      },
    }),
    80,
    tools,
    (text) => `\x1b[2m${text}\x1b[0m`,
  );
  assert.match(colored[0]!, /\x1b\[36m/);
  assert.equal(stripAnsi(colored[0]!), plain[0]);
  for (const role of ["project", "model", "mcp", "agents", "plan", "quota", "cache", "context", "cost"] as const) {
    assert.ok(roles.has(role), `missing semantic role: ${role}`);
  }
  assertWidths(colored, 180);
  assert.equal(tools.visibleWidth(editor), 80);
});

test("handles ANSI and Unicode without exceeding any requested width", () => {
  const decorated = input({
    unknown: ["\x1b[31m警告 🚨 status\x1b[0m"],
    showUnknownStatuses: true,
  });
  for (const width of [1, 2, 5, 12, 30, 80, 160]) {
    const lines = renderFooter(decorated, width, tools);
    assertWidths(lines, width);
  }
});

test("preserves active and critical statuses before optional metrics", () => {
  const critical = input({
    statuses: {
      usage: "7d:9% ↺2h",
      mcp: "MCP:error auth",
      agents: "agents:2+1q",
      plan: "⏸︎ plan",
      mcpError: true,
      agentsActive: true,
      planActive: true,
    },
    metrics: {
      quota: "7d:9% ↺2h",
      cacheHitPercent: 10,
      context: { tokens: 250_000, contextWindow: 272_000, percent: 92 },
      cost: 99.999,
    },
  });
  const line = renderFooter(critical, 90, tools)[0]!;
  assert.match(line, /⏸/);
  assert.match(line, /(?:agents:|A:?)(?:2\+1q)/);
  assert.match(line, /MCP:error auth/);
  assert.match(line, /7d:9% ↺2h/);
  assert.match(line, /(?:ctx:)?92%/);
});

test("requests a render for dynamic branch changes and releases the subscription", () => {
  let callback: (() => void) | undefined;
  let unsubscribed = false;
  let renders = 0;
  const unsubscribe = subscribeToBranchChanges(
    {
      onBranchChange(value) {
        callback = value;
        return () => { unsubscribed = true; };
      },
    },
    () => { renders += 1; },
  );
  callback?.();
  assert.equal(renders, 1);
  unsubscribe();
  assert.equal(unsubscribed, true);
});
