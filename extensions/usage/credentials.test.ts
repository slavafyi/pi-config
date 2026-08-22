import assert from "node:assert/strict";
import test from "node:test";
import { cursorAuthFilePath, resolveCursorAccessToken } from "./credentials.ts";

test("resolves Cursor Agent auth file paths across platforms", () => {
  assert.equal(
    cursorAuthFilePath({ platform: "linux", home: "/home/ori", env: {} }),
    "/home/ori/.config/cursor/auth.json",
  );
  assert.equal(
    cursorAuthFilePath({
      platform: "linux",
      home: "/home/ori",
      env: { XDG_CONFIG_HOME: "/tmp/config" },
    }),
    "/tmp/config/cursor/auth.json",
  );
  assert.equal(
    cursorAuthFilePath({ platform: "darwin", home: "/Users/ori", env: {} }),
    "/Users/ori/.cursor/auth.json",
  );
});

test("reads Linux Cursor Agent credentials from its protected auth file", async () => {
  let requestedPath = "";
  const token = await resolveCursorAccessToken({
    platform: "linux",
    home: "/home/ori",
    env: {},
    readText: async (path) => {
      requestedPath = path;
      return JSON.stringify({ accessToken: "linux-token", refreshToken: "secret" });
    },
  });
  assert.equal(requestedPath, "/home/ori/.config/cursor/auth.json");
  assert.equal(token, "linux-token");
});

test("reads the default macOS Cursor Agent token from Keychain", async () => {
  let invocation: [string, string[]] | undefined;
  const token = await resolveCursorAccessToken({
    platform: "darwin",
    env: {},
    exec: async (command, args) => {
      invocation = [command, args];
      return { stdout: "mac-token\n", code: 0, killed: false };
    },
  });
  assert.deepEqual(invocation, [
    "/usr/bin/security",
    [
      "find-generic-password",
      "-a",
      "cursor-user",
      "-s",
      "cursor-access-token",
      "-w",
    ],
  ]);
  assert.equal(token, "mac-token");
});

test("honors explicit environment and credential-store modes", async () => {
  assert.equal(
    await resolveCursorAccessToken({
      platform: "linux",
      env: { CURSOR_AUTH_TOKEN: "environment-token" },
    }),
    "environment-token",
  );
  assert.equal(
    await resolveCursorAccessToken({
      platform: "darwin",
      env: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
    }),
    undefined,
  );
});
