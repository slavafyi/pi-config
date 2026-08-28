import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type BashToolDetails,
} from "@earendil-works/pi-coding-agent";

export const ALLOWED_MAX_KIB = new Set([10, 20, 30, 40, 50]);

export interface BashOutputLimitConfig {
  maxKiB: number;
}

type ContentBlock = TextContent | ImageContent;

export interface BashOutputLimitInput {
  content: ContentBlock[];
  details?: BashToolDetails;
  maxKiB: number;
  saveFullOutput: (output: string) => Promise<string>;
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

export async function limitBashOutput(
  input: BashOutputLimitInput,
): Promise<BashOutputLimitPatch | undefined> {
  if (input.maxKiB === 50) return undefined;

  const textBlock = input.content.find((block): block is TextContent => block.type === "text");
  if (!textBlock) return undefined;
  const text = textBlock.text;

  const existingPath = input.details?.fullOutputPath;
  const body = stripExistingNotice(text, existingPath);
  const maxBytes = input.maxKiB * 1024;
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return undefined;

  let fullOutputPath = existingPath;
  if (!fullOutputPath) {
    try {
      fullOutputPath = await input.saveFullOutput(text);
    } catch {
      return undefined;
    }
  }

  const narrowed = truncateTail(body, {
    maxBytes,
    maxLines: DEFAULT_MAX_LINES,
  });
  const existingTruncation = input.details?.truncation;
  const truncation = {
    ...narrowed,
    totalLines: existingTruncation?.totalLines ?? narrowed.totalLines,
    totalBytes: existingTruncation?.totalBytes ?? narrowed.totalBytes,
  };
  const startLine = Math.max(1, truncation.totalLines - truncation.outputLines + 1);
  const notice = `[Showing lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines} (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`;
  const content = input.content.map((block) =>
    block === textBlock
      ? { ...block, text: `${narrowed.content}\n\n${notice}` }
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
