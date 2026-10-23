# Local tests and main integration selection

`pnpm test` runs the native, unit, Code OSS, overlay-browser, and UI projects,
then checks coverage. It does not launch Electron. JavaScript/TypeScript coverage
must be 100% for statements, branches, functions, and lines in every production
file; native coverage must be 100% for lines and functions. The coverage merger
reads only the explicitly supplied component directory, so a previous Electron
run cannot fill a hole in the local result.

`pnpm test:all` adds the complete Electron suite locally. The `CI` workflow runs
only the native and component coverage gates, lint, and type checks on PRs,
pushes to `main`, and manual dispatch. The native gate runs before expensive
Code OSS preparation so platform failures stop early. Branch pushes do not
create a duplicate CI run, and a newer PR commit cancels its superseded run.

The separate `Main integration` workflow runs only on pushes to `main`. It selects
relevant Electron suites; PRs and manual CI dispatches never launch Electron.
Documentation-only and unit-test-only selections skip desktop preparation too.
Integration retries and pending `fixme` contracts remain visible in the
Playwright report.

`pnpm test:integration` first runs upstream's pre-launch preparation with the pinned
Node runtime. This installs the matching Electron binary and built-in extensions
on a clean checkout and reuses a matching Electron installation on later runs.
The local unit gate does not need this desktop runtime preparation.
Main integration launches the same runner without V8 coverage instrumentation:
its coverage requirement is already enforced by the fresh component tests,
and neither suite selection nor recovery consumes Electron coverage. Local
`test:integration` and `test:all` retain instrumented integration coverage.

## How selection works

[`electron-test-policy.json`](../scripts/coverage/electron-test-policy.json)
records feature ownership: source-path prefixes and the Electron suites that
exercise those features. Changes to multiple areas select the union of their
suites. A change to an Electron test selects that suite directly. Documentation,
unit tests, type tests, and Storybook stories still run the local checks but do
not require Electron by themselves.

The main workflow finds the most recent successful run of `integration.yml`
whose head belongs to this repository's `main` and is an ancestor of the current
head. It compares all changes since that verified baseline, not just the latest
push. Failed runs and coalesced pending pushes therefore remain in scope. Main
integration runs are not cancelled by newer pushes. Missing or inaccessible
history, including the first run of this workflow, conservatively selects all
suites.

The selector uses the baseline's merge base and a NUL-delimited Git diff.
Renames are represented as deletion plus addition, so
both affected areas contribute tests. Added production files follow their
feature's ownership rule. Removed production files are matched by their former
path. The same selector can be run locally with an explicit base.

Any unclassified change runs the full suite. This includes shared runtime and
protocol code, common UI primitives and theme tokens, startup wiring, workspace
access, native code, dependency versions, build scripts, CI, and the selection
policy itself. Electron fixtures, harness changes, deleted test suites, missing
base history, or policy references to missing suites also require a full run.
An empty or malformed selection cannot accidentally invoke Playwright without
filters; only an explicit `skip` decision bypasses the integration step.

The rules select whole suites because they express feature contracts, including
failure and recovery cases. They do not depend on which lines happened to run in
an earlier execution. This avoids stale maps and the startup coverage shared by
every Electron worker. It is a conservative maintained ownership map, not a
proof that changes cannot affect another feature. When a new dependency crosses
feature boundaries, extend its rule or leave the affected shared source on the
full-suite fallback. Shared or unknown changes still get a full run on `main`.

## Recovering a failed main integration run

Every main integration attempt writes a small `electron-recovery-<run>-<attempt>`
artifact, even when tests fail. Its manifest records the validated head and base,
branch, repository, runner platform/image, Node and Playwright versions, and exact identities of clean
first-attempt passes. The normal evidence artifact includes the recovery plan
and complete Playwright results, so reused results remain distinguishable from
tests executed in the current run.

The next run discovers its current tests before looking for compatible evidence
from the same main integration workflow. It compares the prior tested head to the current
head and invalidates successes using the same conservative ownership rules.
Failures, flaky passes, interrupted or missing results, and new tests rerun.
Previously passing tests in affected suites rerun too. Unaffected clean passes
can be reused across consecutive attempts; a GitHub rerun of the same commit can
therefore execute just the failures. Selection uses Playwright's exact test IDs,
not title patterns. An explicit empty remaining set skips Electron safely.

Changes to the base commit, a force-push that breaks ancestry, a different runner
or Playwright version, or shared/unclassified changes invalidate reuse. Missing,
expired, malformed, or inaccessible artifacts cause tests to run normally.
PR and fork artifacts are never consumed; recovery rejects non-main-push contexts.
Integration uses only read-only Actions access, never a privileged
`pull_request_target` workflow. Native and component coverage gates always run
afresh in the separate `CI` workflow.

A hard runner interruption before Playwright writes its report cannot contribute
new passes, but previously validated inherited passes remain recoverable if the
final artifact step runs. Reports are validated against the pre-run inventory;
missing planned outcomes cannot turn an incomplete run green.

CI stops an integration attempt after three failures and preserves its report.
Unexecuted tests remain unverified and run on the next attempt. This bounds the
cost of a widespread regression without treating the stopped run as successful.
Exclusive `test.only` declarations are rejected in CI.

## Inspect and reproduce a decision

```sh
pnpm test:select --base origin/main --output .artifacts/electron-selection.json
```

The JSON contains the merge base, mode (`full`, `selected`, or `skip`), exact
suite paths, and a reason for every changed path. Selection is for committed
changes in `HEAD`, matching CI. Review it before running:

```sh
GLYPH_ELECTRON_SELECTION=.artifacts/electron-selection.json pnpm test:integration
```

Run this only for `full` or `selected`; for `skip`, no integration command is
needed. On Linux, wrap the command in `xvfb-run -a`. CI publishes the same JSON in
the job summary and uploads it alongside Playwright results, reports, traces,
including when a test fails. The separate `CI` workflow publishes coverage evidence.

Selector tests exercise every ownership prefix against the repository's actual
suite inventory, unions, renames, deleted tests, unknown paths, missing history,
and empty selections. The selector and runner are subject to the same 100%
coverage requirements as other production scripts.
