import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    });
    if (!patch) return;
    return patch;
  });
}
