import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  type BashToolDetails,
} from "@earendil-works/pi-coding-agent";

export const ALLOWED_MAX_KIB = new Set([10, 20, 30, 40, 50]);

export interface BashOutputLimitConfig {
  maxKiB: number;
}

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

export interface BashOutputLimitPatch {
  content: ContentBlock[];
  details: BashToolDetails;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseBashOutputLimitConfig(value: unknown): BashOutputLimitConfig | undefined {
  if (!isObject(value) || !Object.hasOwn(value, "maxKiB")) return undefined;
  const maxKiB = value.maxKiB;
  if (typeof maxKiB !== "number" || !Number.isInteger(maxKiB) || !ALLOWED_MAX_KIB.has(maxKiB)) {
    return undefined;
  }
  return { maxKiB };
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
): Promise<BashOutputLimitPatch | undefined> {
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

  const headBytes = Math.floor(maxBytes / 5);
  const tailBytes = maxBytes - headBytes;
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
  const retainedBytes = retainedHeadBytes + retainedTailBytes;
  const omittedBytes = Math.max(0, totalBytes - retainedBytes);
  const marker = `[... output truncated: ${formatSize(omittedBytes)} omitted ...]`;
  const truncatedContent = joinWindows(windows.head, marker, windows.tail);
  const totalLines = existingTruncation?.totalLines ?? countLines(body);
  const truncation = {
    content: truncatedContent,
    truncated: true,
    truncatedBy: "bytes" as const,
    totalLines,
    totalBytes,
    outputLines: countLines(windows.head) + countLines(windows.tail) + 1,
    outputBytes: retainedBytes,
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
