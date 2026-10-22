# Local tests and PR integration selection

`pnpm test` runs the native, unit, Code OSS, overlay-browser, and UI projects,
then checks coverage. It does not launch Electron. JavaScript/TypeScript coverage
must be 100% for statements, branches, functions, and lines in every production
file; native coverage must be 100% for lines and functions. The coverage merger
reads only the explicitly supplied component directory, so a previous Electron
run cannot fill a hole in the local result.

`pnpm test:all` adds the complete Electron suite. CI runs it on every push to
`main` and on manual workflow dispatch. PRs run the same local gate followed by
the relevant Electron suites. Branch pushes do not create a duplicate CI run,
and a newer PR commit cancels its superseded run. Integration retries and pending
`fixme` contracts remain visible in the Playwright report.

## How selection works

[`electron-test-policy.json`](../scripts/coverage/electron-test-policy.json)
records feature ownership: source-path prefixes and the Electron suites that
exercise those features. Changes to multiple areas select the union of their
suites. A change to an Electron test selects that suite directly. Documentation,
unit tests, type tests, and Storybook stories still run the local checks but do
not require Electron by themselves.

The selector compares the PR checkout against its merge base using a
NUL-delimited Git diff. Renames are represented as deletion plus addition, so
both affected areas contribute tests. Added production files follow their
feature's ownership rule. Removed production files are matched by their former
path. This also works for fork PRs without downloading artifacts or using a
privileged workflow.

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
full-suite fallback. The full `main` run remains the backstop.

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
and coverage summaries, including when a test fails.

Selector tests exercise every ownership prefix against the repository's actual
suite inventory, unions, renames, deleted tests, unknown paths, missing history,
and empty selections. The selector and runner are subject to the same 100%
coverage requirements as other production scripts.
