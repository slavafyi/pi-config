import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TaskContext } from "./types.ts";

export function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n[... excerpt ...]\n";
  const half = Math.floor((maxChars - marker.length) / 2);
  return text.slice(0, half) + marker + text.slice(-(maxChars - marker.length - half));
}

export function buildTaskContext(prompt: string, messages: readonly AgentMessage[]): TaskContext {
  const history: TaskContext["history"] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text.trim()) history.push({ role: message.role, text: excerpt(text, 1600) });
  }
  return { prompt: excerpt(prompt, 8000), history: history.slice(-4) };
}
