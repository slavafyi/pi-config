import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelsPath = fileURLToPath(new URL("../../models.json", import.meta.url));

test("OpenAI retains the configured context window after reload", async () => {
  const runtime = await ModelRuntime.create({
    modelsPath,
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });

  assert.equal(runtime.getError(), undefined);
  assert.equal(runtime.getModel("openai", "gpt-6.1-sol")?.contextWindow, 372_000);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel("openai", "gpt-6.1-sol")?.contextWindow, 372_000);
});
