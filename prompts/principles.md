---
description: Apply principles for the selected development stage
argument-hint: "[auto|plan|implement|verify|all]"
---
Use mode `${1:-auto}` and apply the corresponding principles:

- **auto:** Infer the relevant stage or stages from the request and apply only
  their principles.
- **plan:** Reduce uncertainty quickly. Apply BDUF-lite, KISS, YAGNI, DoR,
  Thin Slice, and Proof First.
- **implement:** Deliver quickly without chaos. Apply Least Surprise,
  Self-Documenting Code, Fail Fast, Separation of Concerns, Boy Scout Rule,
  Least Privilege, SOLID, and Occam’s Razor.
- **verify:** Prove correctness quickly. Apply DoD, Risk-Based Testing,
  Regression Safety, Drift Check, Reproducible Proof, Negative Testing, and
  Fast Feedback.
- **all:** Apply the principles from every stage.
