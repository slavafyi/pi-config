import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  type BashToolDetails,
  type GrepToolDetails,
  type ReadToolDetails,
  type ReadToolInput,
} from "@earendil-works/pi-coding-agent";

export const ALLOWED_MAX_KIB = new Set([10, 20, 30, 40, 50]);
export const LIMITED_TOOL_NAMES = ["bash", "grep", "read"] as const;

export type LimitedToolName = (typeof LIMITED_TOOL_NAMES)[number];

export type ToolOutputLimitConfig = Partial<Record<LimitedToolName, number>>;

type ContentBlock = TextContent | ImageContent;

export interface BashOutputWindows {
  head: string;
  tail: string;
  tailStartsMidLine: boolean;
}

export interface BashOutputLimitInput {
  content: ContentBlock[];
  details?: BashToolDetails;
  maxKiB: number;
  saveFullOutput: (output: string) => Promise<string>;
  readFullOutputWindows?: (
    path: string,
    headBytes: number,
    tailBytes: number,
  ) => Promise<BashOutputWindows>;
}

export interface ToolOutputLimitPatch<TDetails = unknown> {
  content: ContentBlock[];
  details: TDetails;
}

export interface GrepOutputLimitInput {
  content: ContentBlock[];
  details?: GrepToolDetails;
  maxKiB: number;
}

export interface ReadOutputLimitInput {
  content: ContentBlock[];
  details?: ReadToolDetails;
  toolInput: ReadToolInput;
  maxKiB: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseToolOutputLimitConfig(value: unknown): ToolOutputLimitConfig | undefined {
  if (!isObject(value)) return undefined;

  const config: ToolOutputLimitConfig = {};
  for (const toolName of LIMITED_TOOL_NAMES) {
    if (!Object.hasOwn(value, toolName)) continue;
    const maxKiB = value[toolName];
    if (
      typeof maxKiB !== "number" ||
      !Number.isInteger(maxKiB) ||
      !ALLOWED_MAX_KIB.has(maxKiB)
    ) {
      return undefined;
    }
    config[toolName] = maxKiB;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function stripExistingNotice(text: string, fullOutputPath: string | undefined): string {
  if (!fullOutputPath || !text.endsWith("]")) return text;
  const footerStart = text.lastIndexOf("\n\n[");
  if (footerStart === -1 || !text.slice(footerStart).includes(fullOutputPath)) return text;
  return text.slice(0, footerStart);
}

function takeHeadUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes));
}

function isToolNotice(text: string): boolean {
  return /^\[(?:Output truncated|Showing lines \d|Line \d+ is |Some lines truncated|\d+ (?:matches|more lines)|\d+(?:\.\d+)?(?:B|KB|MB) limit reached)/.test(
    text,
  );
}

function splitTrailingNotices(text: string): { body: string; notices: string[] } {
  const notices: string[] = [];
  let body = text;

  while (body.endsWith("]")) {
    const noticeStart = body.lastIndexOf("\n\n[");
    if (noticeStart === -1) break;
    const notice = body.slice(noticeStart + 2);
    if (notice.includes("\n") || !isToolNotice(notice)) break;
    notices.unshift(notice);
    body = body.slice(0, noticeStart);
  }

  return { body, notices };
}

function limitTextHead(text: string, maxBytes: number): string {
  const marker = "[... output omitted ...]";
  const headBytes = maxBytes - Buffer.byteLength(marker, "utf8") - 1;
  const head = takeHeadUtf8(text, headBytes);
  return `${head}${head.endsWith("\n") ? "" : "\n"}${marker}`;
}

function limitReadHead(
  text: string,
  maxBytes: number,
): { content: string; completeLines: number; linePartial: boolean } {
  const marker = "[... output omitted ...]";
  const headBytes = maxBytes - Buffer.byteLength(marker, "utf8") - 1;
  let head = takeHeadUtf8(text, headBytes);
  const wasCut = Buffer.byteLength(head, "utf8") < Buffer.byteLength(text, "utf8");
  let linePartial = wasCut && !head.endsWith("\n");

  if (linePartial) {
    const lastNewline = head.lastIndexOf("\n");
    if (lastNewline !== -1) {
      head = head.slice(0, lastNewline + 1);
      linePartial = false;
    }
  }

  return {
    content: `${head}${head.endsWith("\n") ? "" : "\n"}${marker}`,
    completeLines: linePartial ? 0 : countLines(head),
    linePartial,
  };
}

function takeTailUtf8(text: string, maxBytes: number): { text: string; startsMidLine: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, startsMidLine: false };

  let start = bytes.length - maxBytes;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return {
    text: bytes.subarray(start).toString("utf8"),
    startsMidLine:
      start > 0 && bytes[start] !== 0x0a && bytes[start - 1] !== 0x0a,
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function joinWindows(head: string, marker: string, tail: string): string {
  const headSeparator = head.endsWith("\n") ? "" : "\n";
  const tailSeparator = tail.startsWith("\n") ? "" : "\n";
  return `${head}${headSeparator}${marker}${tailSeparator}${tail}`;
}

export async function limitBashOutput(
  input: BashOutputLimitInput,
): Promise<ToolOutputLimitPatch<BashToolDetails> | undefined> {
  if (input.maxKiB === 50) return undefined;

  const textBlock = input.content.find((block): block is TextContent => block.type === "text");
  if (!textBlock) return undefined;
  const text = textBlock.text;

  const existingPath = input.details?.fullOutputPath;
  const existingTruncation = input.details?.truncation;
  const body = stripExistingNotice(text, existingPath);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  const totalBytes = existingTruncation?.totalBytes ?? bodyBytes;
  const maxBytes = input.maxKiB * 1024;
  if (totalBytes <= maxBytes) return undefined;

  const marker = "[... middle omitted ...]";
  const windowBytes = maxBytes - Buffer.byteLength(marker, "utf8") - 2;
  const headBytes = Math.floor(windowBytes / 5);
  const tailBytes = windowBytes - headBytes;
  let fullOutputPath = existingPath;
  let windows: BashOutputWindows;
  try {
    if (fullOutputPath) {
      if (!input.readFullOutputWindows) return undefined;
      windows = await input.readFullOutputWindows(fullOutputPath, headBytes, tailBytes);
    } else {
      fullOutputPath = await input.saveFullOutput(text);
      const tail = takeTailUtf8(body, tailBytes);
      windows = {
        head: takeHeadUtf8(body, headBytes),
        tail: tail.text,
        tailStartsMidLine: tail.startsMidLine,
      };
    }
  } catch {
    return undefined;
  }

  const retainedHeadBytes = Buffer.byteLength(windows.head, "utf8");
  const retainedTailBytes = Buffer.byteLength(windows.tail, "utf8");
  const truncatedContent = joinWindows(windows.head, marker, windows.tail);
  const outputBytes = Buffer.byteLength(truncatedContent, "utf8");
  const totalLines = existingTruncation?.totalLines ?? countLines(body);
  const truncation = {
    content: truncatedContent,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines,
    totalBytes,
    outputLines: countLines(truncatedContent),
    outputBytes,
    lastLinePartial: windows.tailStartsMidLine,
    firstLineExceedsLimit: false,
    maxLines: DEFAULT_MAX_LINES,
    maxBytes,
  };
  const notice = `[Output truncated: showing first ${formatSize(retainedHeadBytes)} and last ${formatSize(retainedTailBytes)} of ${formatSize(totalBytes)}. Full output: ${fullOutputPath}]`;
  const content = input.content.map((block) =>
    block === textBlock
      ? { ...block, text: `${truncatedContent}\n\n${notice}` }
      : block,
  );

  return {
    content,
    details: {
      ...input.details,
      truncation,
      fullOutputPath,
    },
  };
}

export function limitGrepOutput(
  input: GrepOutputLimitInput,
): ToolOutputLimitPatch<GrepToolDetails> | undefined {
  if (input.maxKiB === 50) return undefined;

  const textBlock = input.content.find((block): block is TextContent => block.type === "text");
  if (!textBlock) return undefined;

  const { body, notices } = splitTrailingNotices(textBlock.text);
  const maxBytes = input.maxKiB * 1024;
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return undefined;

  const details = input.details as (GrepToolDetails & { nextCursor?: unknown }) | undefined;
  const cursorNotice =
    typeof details?.nextCursor === "string"
      ? ` Continue with cursor=${details.nextCursor}, or refine the pattern and reduce context.`
      : " Refine the pattern or reduce context for a smaller result.";
  const extensionNotice = `[Output limited to ${formatSize(maxBytes)} by tool-output-limit.${cursorNotice}]`;
  const truncatedContent = limitTextHead(body, maxBytes);
  const text = [truncatedContent, ...notices, extensionNotice].join("\n\n");
  const existingTruncation = input.details?.truncation;
  const truncation = {
    ...existingTruncation,
    content: truncatedContent,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines: existingTruncation?.totalLines ?? countLines(body),
    totalBytes: existingTruncation?.totalBytes ?? Buffer.byteLength(body, "utf8"),
    outputLines: countLines(truncatedContent),
    outputBytes: Buffer.byteLength(truncatedContent, "utf8"),
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: existingTruncation?.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes,
  };

  return {
    content: input.content.map((block) =>
      block === textBlock ? { ...block, text } : block,
    ),
    details: {
      ...input.details,
      truncation,
    },
  };
}

export function limitReadOutput(
  input: ReadOutputLimitInput,
): ToolOutputLimitPatch<ReadToolDetails | undefined> | undefined {
  if (input.maxKiB === 50) return undefined;

  const textBlock = input.content.find((block): block is TextContent => block.type === "text");
  if (!textBlock) return undefined;

  const { body } = splitTrailingNotices(textBlock.text);
  const maxBytes = input.maxKiB * 1024;
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return undefined;

  const limited = limitReadHead(body, maxBytes);
  const startLine = Math.max(1, input.toolInput.offset ?? 1);
  const continuation = limited.linePartial
    ? `The first returned line exceeds ${formatSize(maxBytes)}; read offset cannot continue within a line.`
    : `Continue reading ${input.toolInput.path} with offset=${startLine + limited.completeLines}.`;
  const notice = `[Output limited to ${formatSize(maxBytes)} by tool-output-limit. ${continuation}]`;
  const text = `${limited.content}\n\n${notice}`;
  const existingTruncation = input.details?.truncation;
  const truncation = {
    ...existingTruncation,
    content: limited.content,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines: existingTruncation?.totalLines ?? countLines(body),
    totalBytes: existingTruncation?.totalBytes ?? Buffer.byteLength(body, "utf8"),
    outputLines: countLines(limited.content),
    outputBytes: Buffer.byteLength(limited.content, "utf8"),
    lastLinePartial: limited.linePartial,
    firstLineExceedsLimit: limited.linePartial,
    maxLines: existingTruncation?.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes,
  };

  return {
    content: input.content.map((block) =>
      block === textBlock ? { ...block, text } : block,
    ),
    details: {
      ...input.details,
      truncation,
    },
  };
}
