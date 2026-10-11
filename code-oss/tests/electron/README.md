# Glyph Electron integration tests

These tests launch the actual Code OSS Electron application and interact with
Glyph through its command palette, composer, buttons, and rendered transcript.
Messages cross the production renderer, Electron main, MessagePort, and utility
host path. The suite never resolves workbench services, injects IPC messages, or
replaces application objects from Playwright.

Most tests explicitly select `GLYPH_DESKTOP_TEST_RUNTIME=deterministic`.
This selects a reproducible response source without sending paid provider
requests or reading account credentials. It still loads the packaged host and
native dependencies. Passing these tests proves desktop transport and UI
behavior; it does not prove provider inference, durable chat storage, or proposal
editing. Each test has its own Electron process, temporary workspace, user-data
directory, and extensions directory. A sentinel file must remain unchanged.

The production-startup group sets the `productionRuntime` fixture option and
leaves the runtime selector unset. It verifies that the real service composition
starts and gives an actionable sign-in diagnostic when no account exists. Every
test isolates `GLYPH_CONFIG_DIR` and `CHAT_TRACE_FILE` inside its temporary
sandbox and removes inherited `CHAT_MODEL` and `OPENAI_*` environment variables.
The production test therefore uses an empty account store and sends no provider
request.

## Run

After bootstrapping and installing Code OSS:

```sh
pnpm desktop:artifact
pnpm code-oss:apply
pnpm code-oss:compile
node scripts/code-oss/test-electron.mjs
```

Review the coverage contract without launching Electron:

```sh
node scripts/code-oss/test-electron.mjs --list
```

Run one behavior by its description:

```sh
node scripts/code-oss/test-electron.mjs --grep 'cancels an answer'
```

The runner uses the Node and Playwright versions already installed in the pinned
Code OSS checkout. No second Playwright installation or browser download is
needed. Electron supplies Chromium. On Linux, provide a display, for example
`xvfb-run -a node scripts/code-oss/test-electron.mjs`; Electron does not use the
browser runner's headless setting. macOS opens automated application windows.

## Coverage and pending work

`GlyphWorkbench.test.mjs` is the executable coverage inventory. Its descriptions
state user-visible behavior, including native sidebar discovery, complete and
partial responses, keyboard submission, multiline input, empty submissions,
literal markup, draft/focus preservation during streaming, stable response DOM
identity, cancellation and reuse, successive turns, window reload and
conversation restoration, workspace trust, overlapping workspace ownership, and
production startup without an account.

The pending groups use `it.fixme` deliberately (`it` aliases Playwright's test API).
Those descriptions are visible in test discovery and reports, but they are
specifications, not passing tests. They cover partial-answer replay, utility-host
recovery, account and model selection, questions, approvals, tools, usage,
attachments, proposals, guarded editing/Undo, and multiple-window ownership.
Enable a pending contract when the user-facing feature exists, then replace the
empty body with interactions and assertions. Hidden-service calls do not satisfy
the black-box contract.

The roadmap groups also specify chat annotations, editor Tab completion, inline
proposal rebuttals, queue/interrupt/steer controls, compaction, usage metering,
settings, language-server context, and user-authorized cross-chat communication.
Hook cases name each lifecycle event and its permitted effects, including
non-blocking notifications, approvals, input rewrites, and MCP-only result
replacement. These are acceptance contracts, not implemented hooks or evidence
of coverage. The existing active-turn draft test describes today's behavior;
queue/interrupt/steer contracts describe its planned replacement.

## Failure evidence

Every executed test retains a Playwright trace, final screenshot, Electron
output, and Code OSS logs under `.artifacts/code-oss-integration/results`.
The HTML report is `.artifacts/code-oss-integration/report/index.html`, and
`results.json` provides machine-readable passed/failed/skipped counts. These
directories are already excluded through the repository's `.artifacts/` rule.
Playwright replaces the previous run's report, so copy evidence elsewhere before
starting another run if it must be retained.

Tests run serially and do not retry automatically. A timing or startup failure
therefore remains visible instead of disappearing behind a successful retry.
The fixture response delay is set to 80 ms per chunk so streaming and cancellation
can be observed through the UI. Tests wait on visible conditions rather than
using fixed sleeps.
