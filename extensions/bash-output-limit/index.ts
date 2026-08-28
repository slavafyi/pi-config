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

async function readFullOutputHead(path: string, maxBytes: number): Promise<string> {
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
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return new StringDecoder("utf8").write(buffer.subarray(0, bytesRead));
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
      readFullOutputHead,
    });
    if (!patch) return;
    return patch;
  });
}
