# Agent guidance

## Test iteration and validation

**The full test suite takes literal hours. Treat a full run as a final validation step, not an iteration tool.**

- During development, run the most targeted possible tests: a specific test case,
  then its test file or affected component as needed. Choose tests that exercise
  the changed behavior and its relevant callers.
- Use focused regression tests while investigating failures, addressing review
  feedback, resolving conflicts, and integrating changes. Broaden testing only
  when a concrete dependency or unresolved failure requires it.
- The standard is **one full test-suite run on the final assembled changes before
  pushing**. Finish implementation, integration, and review fixes before starting
  that run. Avoid full runs on intermediate commits or each slice of a PR stack.
- If final validation fails, diagnose and iterate with targeted tests. Repeat a
  full run only when necessary to establish final validity; explain why the
  earlier result cannot be reused.
- Coordinate with sub-agents so they use focused tests and share results. Keep
  full validation under one coordinator; do not launch duplicate full suites.
- Preserve existing coverage thresholds and meaningful assertions. Targeted
  iteration changes which tests run, not the acceptance standard.
- Documentation-only changes need relevant formatting and content checks, not
  application test suites.
- Report exactly what was tested, whether results apply to the current changes,
  and any remaining validation. Give progress updates during long runs.

## Workspace access

For changes that read or change workspace files, supply model context, or run
commands, follow [implement-workspace-access](.glyph/skills/implement-workspace-access/SKILL.md).
For review, follow [review-workspace-access](.glyph/skills/review-workspace-access/SKILL.md).
The [workspace access guide](docs/WORKSPACE_ACCESS.md) identifies the authority
for each operation and explains how its lifetime affects callers.
