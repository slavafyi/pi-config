import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ExecResult {
  stdout: string;
  code: number;
  killed: boolean;
}

export interface CursorCredentialOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exec?: (command: string, args: string[]) => Promise<ExecResult>;
  readText?: (path: string) => Promise<string>;
}

export function cursorAuthFilePath(options: CursorCredentialOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (platform === "darwin") return join(home, ".cursor", "auth.json");
  if (platform === "linux") {
    return join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor", "auth.json");
  }
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  }
  return undefined;
}

function parseCursorAuthFile(text: string): string | undefined {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const token = (value as { accessToken?: unknown }).accessToken;
  return typeof token === "string" && token.trim() ? token : undefined;
}

export async function resolveCursorAccessToken(
  options: CursorCredentialOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (env.CURSOR_AUTH_TOKEN?.trim()) return env.CURSOR_AUTH_TOKEN;
  if (env.AGENT_CLI_CREDENTIAL_STORE === "memory") return undefined;

  const platform = options.platform ?? process.platform;
  const useFile = env.AGENT_CLI_CREDENTIAL_STORE === "file" || platform !== "darwin";
  if (useFile) {
    const path = cursorAuthFilePath(options);
    if (!path) return undefined;
    try {
      return parseCursorAuthFile(await (options.readText ?? ((file) => readFile(file, "utf8")))(path));
    } catch {
      return undefined;
    }
  }

  if (!options.exec) return undefined;
  const result = await options.exec("/usr/bin/security", [
    "find-generic-password",
    "-a",
    "cursor-user",
    "-s",
    "cursor-access-token",
    "-w",
  ]);
  if (result.killed || result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
