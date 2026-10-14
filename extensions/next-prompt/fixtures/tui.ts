import { appendFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function tuiFixture(pi: ExtensionAPI) {
  const log = process.env.NEXT_PROMPT_SMOKE_LOG!;
  const suggestion = process.env.NEXT_PROMPT_SMOKE_LANGUAGE === "ru" ? "давай добавим тесты" : "Let's add tests.";
  const faux = createFauxCore({
    provider: "next-prompt-fixture",
    models: [{ id: "main", name: "Offline Main", contextWindow: 200_000 }, { id: "suggestion", name: "Offline Suggestion", contextWindow: 200_000 }],
  });
  faux.setResponses(Array.from({ length: 32 }, () => (_context, _options, _state, model) => {
    appendFileSync(log, JSON.stringify({ kind: "request", model: model.id }) + "\n");
    return fauxAssistantMessage(model.id === "main" ? "Done. Tests pass." : suggestion);
  }));
  pi.registerProvider("next-prompt-fixture", {
    api: faux.api, apiKey: "offline", baseUrl: "https://example.invalid",
    streamSimple: faux.streamSimple, models: faux.models,
  });
  pi.on("input", (event) => {
    appendFileSync(log, JSON.stringify({ kind: "input", text: event.text }) + "\n");
  });
}
