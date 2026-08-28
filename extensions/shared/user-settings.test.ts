import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadExtensionSettings,
  loadUserSettings,
  parseUserSettings,
} from "./user-settings.ts";

test("parses only JSON objects", () => {
  assert.deepEqual(parseUserSettings('{"extensions":{}}'), { extensions: {} });
  assert.equal(parseUserSettings("[]"), undefined);
  assert.equal(parseUserSettings("invalid"), undefined);
});

test("missing and invalid user settings are unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-user-settings-"));
  try {
    assert.equal(loadUserSettings(directory), undefined);
    writeFileSync(join(directory, "user-settings.json"), "invalid");
    assert.equal(loadUserSettings(directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loads independent extension namespaces", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-user-settings-"));
  try {
    writeFileSync(
      join(directory, "user-settings.json"),
      JSON.stringify({
        extensions: {
          "bash-output-limit": { maxKiB: 20 },
          footer: { showUnknownStatuses: true },
        },
      }),
    );

    assert.deepEqual(loadExtensionSettings("bash-output-limit", directory), { maxKiB: 20 });
    assert.deepEqual(loadExtensionSettings("footer", directory), {
      showUnknownStatuses: true,
    });
    assert.equal(loadExtensionSettings("missing", directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires an extensions object", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-user-settings-"));
  try {
    writeFileSync(join(directory, "user-settings.json"), '{"extensions":null}');
    assert.equal(loadExtensionSettings("footer", directory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
