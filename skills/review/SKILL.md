---
name: review
description: Review a concrete change for defects, regressions and missing verification before integration.
---
Read the supplied commit or diff and the affected callers. Tie findings to observable failures, with file references and a reproduction or a clearly stated uncertainty. Prioritize correctness and regressions over style. Run checks that substantiate the findings; distinguish tests run from suggested checks.

Return a verdict, actionable findings, and what was verified. When delegated, finish the board task with the verdict and commit reference; requesting changes is a completed review, not a failed execution. Record recurring review problems as skill feedback. Respect the requested review scope.
