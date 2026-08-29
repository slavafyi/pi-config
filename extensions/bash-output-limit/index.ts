import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  BashToolDetails,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { loadExtensionSettings } from "../shared/user-settings.ts";
import {
  limitBashOutput,
  parseBashOutputLimitConfig,
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

export default function bashOutputLimit(pi: ExtensionAPI) {
  let maxKiB: number | undefined;

  pi.on("session_start", () => {
    maxKiB = parseBashOutputLimitConfig(
      loadExtensionSettings("bash-output-limit"),
    )?.maxKiB;
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" || maxKiB === undefined) return;

    const patch = await limitBashOutput({
      content: event.content,
      details: event.details as BashToolDetails | undefined,
      maxKiB,
      saveFullOutput,
      readFullOutputWindows,
    });
    if (!patch) return;
    return patch;
  });
}
