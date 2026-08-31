import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  BashToolDetails,
  ExtensionAPI,
  GrepToolDetails,
  ReadToolDetails,
  ReadToolInput,
} from "@earendil-works/pi-coding-agent";

import { loadExtensionSettings } from "../shared/user-settings.ts";
import {
  limitBashOutput,
  limitGrepOutput,
  limitReadOutput,
  parseToolOutputLimitConfig,
  type ToolOutputLimitConfig,
} from "./core.ts";

async function saveFullOutput(output: string): Promise<string> {
  const path = join(tmpdir(), `pi-bash-${randomUUID()}.log`);
  await writeFile(path, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return path;
}

async function readFullOutputWindows(
  path: string,
  headBytes: number,
  tailBytes: number,
) {
  const relativePath = relative(tmpdir(), path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath) ||
    !basename(path).startsWith("pi-bash-")
  ) {
    throw new Error("Refusing to read an unexpected bash output path");
  }

  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const headBuffer = Buffer.alloc(Math.min(headBytes, size));
    const tailPosition = Math.max(0, size - tailBytes - 1);
    const tailBuffer = Buffer.alloc(size - tailPosition);
    const [{ bytesRead: headBytesRead }, { bytesRead: tailBytesRead }] = await Promise.all([
      file.read(headBuffer, 0, headBuffer.length, 0),
      file.read(tailBuffer, 0, tailBuffer.length, tailPosition),
    ]);

    const head = new StringDecoder("utf8").write(headBuffer.subarray(0, headBytesRead));
    let tailStart = tailBytesRead > tailBytes ? tailBytesRead - tailBytes : 0;
    while (tailStart < tailBytesRead && ((tailBuffer[tailStart] ?? 0) & 0xc0) === 0x80) {
      tailStart += 1;
    }
    const absoluteTailStart = tailPosition + tailStart;
    const tailStartsMidLine =
      absoluteTailStart > 0 &&
      tailBuffer[tailStart] !== 0x0a &&
      tailBuffer[tailStart - 1] !== 0x0a;

    return {
      head,
      tail: tailBuffer.subarray(tailStart, tailBytesRead).toString("utf8"),
      tailStartsMidLine,
    };
  } finally {
    await file.close();
  }
}

export default function toolOutputLimit(pi: ExtensionAPI) {
  let config: ToolOutputLimitConfig = {};

  pi.on("session_start", () => {
    config = parseToolOutputLimitConfig(
      loadExtensionSettings("tool-output-limit"),
    ) ?? {};
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") {
      const maxKiB = config.bash;
      if (maxKiB === undefined) return;
      return limitBashOutput({
        content: event.content,
        details: event.details as BashToolDetails | undefined,
        maxKiB,
        saveFullOutput,
        readFullOutputWindows,
      });
    }

    if (event.toolName === "grep") {
      const maxKiB = config.grep;
      if (maxKiB === undefined) return;
      return limitGrepOutput({
        content: event.content,
        details: event.details as GrepToolDetails | undefined,
        maxKiB,
      });
    }

    if (event.toolName === "read") {
      const maxKiB = config.read;
      if (maxKiB === undefined) return;
      return limitReadOutput({
        content: event.content,
        details: event.details as ReadToolDetails | undefined,
        toolInput: event.input as ReadToolInput,
        maxKiB,
      });
    }
  });
}
