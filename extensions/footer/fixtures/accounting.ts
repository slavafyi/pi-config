import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

function usage(cost: number): Usage {
  return { input: 10, output: 2, cacheRead: 90, cacheWrite: 0, totalTokens: 102,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

export default function accountingFixture(pi: ExtensionAPI) {
  const mode = process.env.ACCOUNTING_MODE;
  const faux = createFauxCore({ provider: "accounting-fixture", models: [{ id: "physical", contextWindow: 200000 }] });
  const parameters = { type: "object", properties: {} } as ToolDefinition["parameters"];
  pi.registerTool({ name: "spend", label: "Spend", description: "Offline nested usage fixture", parameters,
    async execute() { return { content: [{ type: "text", text: "SPENT" }], details: undefined, usage: usage(0.125) }; } });
  pi.registerTool({ name: "nested_spend", label: "Nested spend", description: "Offline nested usage fixture", parameters,
    async execute(_id, _args, _signal, _update, ctx) {
      await ctx.executeTool("spend", {});
      return { content: [{ type: "text", text: "NESTED" }], details: undefined, usage: usage(0.03125) };
    } });
  pi.on("message_end", event => {
    if (event.message.role === "assistant") return { message: { ...event.message, usage: usage(0.25) } };
  });
  let turns = 0;
  faux.setResponses(Array.from({ length: 4 }, () => () => {
    turns++;
    const response = turns === 1
      ? fauxAssistantMessage(fauxToolCall(mode === "direct" ? "spend" : "codemode", mode === "direct" ? {} : { code:
        mode === "failed" ? 'await tools.spend({}); throw new Error("expected failure");' :
          'await Promise.all([tools.spend({}), tools.nested_spend({})]); text("DONE");' }, { id: "call-1" }), { stopReason: "toolUse" })
      : fauxAssistantMessage("ACCOUNTING_COMPLETE");
    return response;
  }));
  pi.registerProvider("accounting-fixture", { api: faux.api, apiKey: "offline", baseUrl: "https://example.invalid",
    streamSimple: faux.streamSimple, models: faux.models });
  pi.registerVirtualModel({ provider: "accounting-router", id: "auto", name: "Offline router",
    route(_request, ctx) { return { model: ctx.modelRegistry.find("accounting-fixture", "physical")!, thinkingLevel: "off" }; } });
}
