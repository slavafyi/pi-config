---
description: Apply principles for the selected development stage
argument-hint: "[plan|implement|verify|all] [task]"
---
Request: ${ARGUMENTS:-the current request from the conversation}

If the request starts with `plan`, `implement`, `verify`, or `all`, use it as
the mode. Otherwise, infer the mode and treat the entire request as the task.
If no task remains, use the current request from the conversation. Apply the
corresponding principles:

- **plan:** Reduce uncertainty quickly. Apply BDUF-lite, KISS, YAGNI, DoR,
  Thin Slice, and Proof First.
- **implement:** Deliver quickly without chaos. Apply Least Surprise,
  Self-Documenting Code, Fail Fast, Separation of Concerns, Boy Scout Rule,
  Least Privilege, SOLID, and Occam’s Razor.
- **verify:** Prove correctness quickly. Apply DoD, Risk-Based Testing,
  Regression Safety, Drift Check, Reproducible Proof, Negative Testing, and
  Fast Feedback.
- **all:** Apply the principles from every stage.
