import assert from "node:assert/strict";
import test from "node:test";
import { extractTodoItems } from "./utils.ts";

test("retains indented substeps and wrapped conditions without creating extra todos", () => {
  const items = extractTodoItems(`Plan:
1. Check available models.
2. Launch two agents in parallel:
   - **Background**: check the date and timezone.
   - Foreground: check \`git status\`.
     1. Do not modify files.
     2. Do not use Spark.
   Preserve both results.

3. Compile the final report.

Explanation outside the plan.
1. This is not a new plan step.
`);
  assert.deepEqual(items.map(item => item.text), [
    "Check available models.",
    "Launch two agents in parallel: - Background: check the date and timezone. - Foreground: check git status. 1. Do not modify files. 2. Do not use Spark. Preserve both results.",
    "Compile the final report.",
  ]);
  assert.deepEqual(items.map(item => item.step), [1, 2, 3]);
});

test("supports indented plans and does not cut a step at inline Markdown", () => {
  assert.deepEqual(extractTodoItems(`**Plan:**
  1. Check **all** conditions and the step's \`code\`.
\t- Preserve the nested condition.
  2. Present the complete report.
`).map(item => item.text), [
    "Check all conditions and the step's code. - Preserve the nested condition.",
    "Present the complete report.",
  ]);
});
