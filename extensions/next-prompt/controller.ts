import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildTranscript, isCompletedReply, parseSuggestion, SYSTEM_PROMPT, USAGE_ENTRY, type Config } from "./core.ts";

interface Source {
  ctx: ExtensionContext;
  sessionId: string;
  leafId: string | null;
  modelProvider: string | undefined;
  modelId: string | undefined;
}

export class PredictionController {
  private generation = 0;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready: { text: string; source: Source } | undefined;
  private readonly onChange: () => void;
  private readonly onUsage: (message: AssistantMessage, ctx: ExtensionContext) => void;
  private readonly timeoutMs: number;

  constructor(
    onChange: () => void,
    onUsage: (message: AssistantMessage, ctx: ExtensionContext) => void,
    timeoutMs = 10_000,
  ) {
    this.onChange = onChange;
    this.onUsage = onUsage;
    this.timeoutMs = timeoutMs;
  }

  get suggestion(): string | undefined {
    const ready = this.ready;
    if (!ready) return undefined;
    try {
      return this.isCurrent(ready.source) ? ready.text : undefined;
    } catch {
      return undefined; // Context may have been invalidated by reload or a session switch.
    }
  }

  cancel(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    const hadSuggestion = Boolean(this.ready);
    this.ready = undefined;
    if (hadSuggestion) this.onChange();
  }

  request(ctx: ExtensionContext, config: Config): void {
    this.cancel();
    if (!this.isEligible(ctx) || !isCompletedReply(ctx.sessionManager.getBranch())) return;
    const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
    if (!model) return;
    const source: Source = {
      ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      leafId: ctx.sessionManager.getLeafId(),
      modelProvider: ctx.model?.provider,
      modelId: ctx.model?.id,
    };
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.timer = setTimeout(() => {
      if (this.generation === generation) this.cancel();
    }, this.timeoutMs);
    void this.run(source, model, generation, abort);
  }

  private isEligible(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && ctx.isIdle() && !ctx.hasPendingMessages() && ctx.ui.getEditorText() === "";
  }

  private isCurrent(source: Source): boolean {
    const { ctx } = source;
    if (!this.isEligible(ctx) || ctx.sessionManager.getSessionId() !== source.sessionId ||
      ctx.model?.provider !== source.modelProvider || ctx.model?.id !== source.modelId) return false;
    // Accounting may finish out of order. Only our non-context usage entries are transparent;
    // a new message, context edit, or different branch still invalidates the prediction.
    let leafId = ctx.sessionManager.getLeafId();
    while (leafId !== source.leafId) {
      if (!leafId) return false;
      const entry = ctx.sessionManager.getEntry(leafId);
      if (entry?.type !== "custom" || entry.customType !== USAGE_ENTRY) return false;
      leafId = entry.parentId;
    }
    return true;
  }

  private async run(source: Source, model: NonNullable<ExtensionContext["model"]>, generation: number, abort: AbortController): Promise<void> {
    const { ctx } = source;
    try {
      const message = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildTranscript(ctx.sessionManager.getBranch()), timestamp: Date.now() }],
      }, {
        signal: abort.signal,
        reasoning: "minimal",
        // Stateless side request: never use the main Codex WebSocket conversation.
        transport: "sse",
      }).result();
      const current = generation === this.generation && !abort.signal.aborted && this.isCurrent(source);
      if (ctx.sessionManager.getSessionId() === source.sessionId) this.onUsage(message, ctx);
      if (!current) return;
      if (!this.isCurrent(source) || generation !== this.generation || abort.signal.aborted || message.stopReason !== "stop") return;
      const text = parseSuggestion(message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
      if (!text) return;
      this.ready = { text, source };
      this.onChange();
    } catch {
      // Suggestions are optional: transport errors and invalidated contexts must not interrupt input.
    } finally {
      if (this.abort === abort) {
        this.abort = undefined;
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    }
  }
}
