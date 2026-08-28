import { readFileSync } from "node:fs";
import { join } from "node:path";

export type UserSettingsObject = Record<string, unknown>;

function isObject(value: unknown): value is UserSettingsObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseUserSettings(text: string): UserSettingsObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function loadUserSettings(
  codingAgentDir = process.env.PI_CODING_AGENT_DIR,
): UserSettingsObject | undefined {
  if (!codingAgentDir) return undefined;
  try {
    return parseUserSettings(readFileSync(join(codingAgentDir, "user-settings.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function loadExtensionSettings(
  extensionName: string,
  codingAgentDir = process.env.PI_CODING_AGENT_DIR,
): unknown {
  const settings = loadUserSettings(codingAgentDir);
  if (!settings || !isObject(settings.extensions)) return undefined;
  return Object.hasOwn(settings.extensions, extensionName)
    ? settings.extensions[extensionName]
    : undefined;
}
