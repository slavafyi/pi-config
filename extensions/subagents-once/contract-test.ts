import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".config/pi/agent");
  const packageDir = join(agentDir, "git/github.com/nicobailon/pi-subagents");
  const delegation = await import(pathToFileURL(join(packageDir, "src/api/delegation.ts")).href);
  const { resolveSubagentLaunchContract } = await import(
    pathToFileURL(join(packageDir, "src/api/preflight.ts")).href
  );
  const { parseSubagentDelegationRequest } = await import(
    pathToFileURL(join(packageDir, "src/slash/delegation-request.ts")).href
  );

  assert.equal(delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, "prompt-template:subagent:request");
  assert.equal(delegation.SUBAGENT_DELEGATION_UPDATE_EVENT, "prompt-template:subagent:update");
  assert.equal(delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, "prompt-template:subagent:response");
  assert.equal(delegation.SUBAGENT_DELEGATION_CANCEL_EVENT, "prompt-template:subagent:cancel");

  const parsed = parseSubagentDelegationRequest({
    requestId: "request",
    ownerRunId: "owner",
    nodeId: "node",
    agent: "oracle",
    task: "Challenge the direction without modifying files.",
    context: "fork",
    cwd: process.cwd(),
    result: { kind: "text" },
  });
  if (!parsed.ok) throw new Error(parsed.error);

  const reviewer = await resolveSubagentLaunchContract({
    agent: "reviewer",
    cwd: process.cwd(),
    task: "Review without modifying files.",
    context: "fresh",
  });
  if (!reviewer.ok) throw new Error(reviewer.message);
  assert.deepEqual(reviewer.contract.tools.effectiveAllowlist, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "intercom",
  ]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
