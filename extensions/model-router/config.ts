import { DEFAULT_PROFILES } from "./profiles.ts";
import type { ModelProfile } from "./types.ts";

export interface RouterConfig {
  enabled: boolean;
  evaluator: { type: "jev"; provider: string; model: string };
  timeoutMs: number;
  profiles: readonly ModelProfile[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/~:-]{0,199}$/.test(value);
}

function description(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 2000;
}

export function parseRouterConfig(value: unknown): RouterConfig | undefined {
  if (!isObject(value) || typeof value.enabled !== "boolean") return undefined;
  const evaluator = value.evaluator ?? { type: "jev", provider: "typesafe", model: "jev-latest" };
  if (!isObject(evaluator) || evaluator.type !== "jev" || !identifier(evaluator.provider) || !identifier(evaluator.model)) return undefined;
  const timeoutMs = value.timeoutMs ?? 2000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) return undefined;
  const profiles = value.profiles ?? DEFAULT_PROFILES;
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 8) return undefined;
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (!isObject(profile) || profile.provider !== "openai-codex" || !identifier(profile.model) ||
      !description(profile.role) || !description(profile.useWhen) || !description(profile.avoidWhen)) return undefined;
    if (seen.has(profile.model)) return undefined;
    seen.add(profile.model);
  }
  return {
    enabled: value.enabled,
    evaluator: { type: "jev", provider: evaluator.provider, model: evaluator.model },
    timeoutMs,
    profiles: profiles as unknown as ModelProfile[],
  };
}
