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
directory, and extensions directory unless it opts into a shared launch. A
sentinel file must remain unchanged.

The production-startup group sets the `productionRuntime` fixture option and
leaves the runtime selector unset. It verifies that the real service composition
starts and gives an actionable sign-in diagnostic when no account exists. Every
test isolates `GLYPH_CONFIG_DIR` and `CHAT_TRACE_FILE` inside its temporary
sandbox and removes inherited `CHAT_MODEL` and `OPENAI_*` environment variables.
The production test therefore uses an empty account store and sends no provider
request.

Tests that need real provider/tool/persistence behavior use
`it.use({ scriptedProvider: true })`. This keeps the production composition,
OpenAI adapter, agent loop, editor RPC, and SQLite chat store. Only the HTTP
transport changes: catalog and Responses requests go to an isolated local
server, using a fabricated account in the test's temporary state directory.
The transport rejects unexpected destinations and redirects without falling
back to a live provider. The application environment selects it explicitly with
`GLYPH_DESKTOP_TEST_RUNTIME=scripted` and `GLYPH_DESKTOP_TEST_PROVIDER_URL`.

The `provider` fixture accepts scripted rounds through `provider.enqueue(...)`.
A round can contain text `chunks`, Responses `output` items (including tool
calls), and `hold: true` to pause completion until `provider.release(index)`.
Tests wait for observable output or recorded requests instead of racing a
fixed response delay. The server survives utility-host restarts, records each
request body and stream closure, and rejects extra requests. Unconsumed rounds
also fail the test. `provider-requests.json` is attached to the report so tool
results and provider history can be inspected directly.

Rounds also accept `reasoning: string[]` and
`usage: { input, cached, output, reasoning, total }`. Set `usage: null` to
exercise a missing report. Held rounds stream reasoning/text immediately and
publish their usage only when released.

`GlyphScriptedProvider.test.mjs` proves the seam by requesting a real project
file read through the production agent and asserting its unique fixture content
in the next provider request. Future tool contracts should use this path and
assert the recorded continuation as well as visible workbench behavior.

## Shared launches

Starting Code OSS takes longer than most test bodies. A describe block can opt in
with `it.use({ sharedLaunch: true })` and `it.describe.configure({ mode: 'default' })`.
Its tests then run in order on one worker and reuse that worker's launch whenever
every launch option matches: runtime, accounts, workspace files, additional roots,
settings, keybindings, and extension path.

Before a reused test, the fixture reverts and closes editors, hides the panel,
clears notifications, keeps leftover pending reviews, closes every chat tab,
restores the declared workspace files, and resets the scripted provider. It then
compares the layout and chat surfaces with the state recorded right after launch.
Any difference starts a fresh launch instead. A launch is discarded after a failed
test, a window reload, a host restart, an extra window, unfinished provider work,
queued messages, or changed user settings. Only scripted-provider launches are
reused, because the deterministic runtime cannot open a new chat.

Tests that need a pristine process pass `isolatedLaunch(reason)` as their test
details. Every test records `glyph launch`, `glyph setup ms`, `glyph body ms`, and
`glyph teardown ms` annotations. Set `GLYPH_ELECTRON_SHARED_LAUNCH=0` to give every
test its own launch.

## Run

`pnpm test` runs the local coverage gate without Electron. `pnpm test:all`
includes this full integration suite. PR CI does not run Electron. A separate
main-only integration workflow selects suites by feature ownership;
see [test selection](test-selection.md) for the rules, conservative fallbacks,
and commands to inspect or reproduce a decision.

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

`GlyphTodos.test.mjs` covers the four rank-8 action-item contracts plus malformed
updates, replacement/clearing, and host-failure recovery. Agent calls use
`todo.update_todos` through the production runtime and SQLite store. The card
derives its completed count from the selected chat's saved items, expands upward
above the composer, and displays distinct read-only statuses. Tests verify live
updates, stable IDs, completion/cancellation, per-chat isolation, renderer reload,
and utility-host restart. Browser coverage also checks keyboard interaction,
literal text, long-list scrolling, and a stationary composer.

`GlyphShells.test.mjs` covers the fourteen rank-6 execute/input/close/list contracts
and a direct-user input/close regression. Commands run through the real native sandbox.
Assertions check streamed output and exit codes, collapsed and expanded cards, restored
foreground output, approval denial, timeout/cancellation, raw input versus newline,
unknown/idle sessions, cross-chat rejection, and termination of a real child process.
Lists retain every session's identity while bounding its output. Provider responses
are scripted; recorded tool results establish what the agent actually received.

`GlyphInteractions.test.mjs` covers the eight rank-5 question and approval contracts
plus queued forms, remembered grants, and interruption regressions. Questions exercise
single/multiple choices and Other text, duplicate submission, cancellation, and the
exact tool result returned to the requesting provider turn. Approval tests execute a
real sandboxed command against an isolated marker file, verify no write before approval
or after denial, and distinguish one-time approval from an exact command/directory
grant persisted across a host restart. Renderer reload and host failure remove stale
controls without resuming their interrupted runs. Browser component tests separately
cover failed acknowledgments, draft retention while switching chats, and read-only controls.

`GlyphProjectTools.test.mjs` covers the eleven rank-4 file listing, reading, and
content-search contracts through the production runtime and native index. Assertions
inspect the tool output delivered to the scripted provider as well as the rendered
answer. Tests edit real Code OSS buffers, verify that searches replace stale disk
matches, check that disk bytes stay unchanged, and cover ignored/sensitive files,
outside-workspace symlinks, limits, invalid regex recovery, and duplicate paths in
multiple roots. `workspaceFiles` and `additionalRoots` seed files before Electron
starts so native index discovery is deterministic.

Rank 7 builds on that existing live-buffer search path. Five additional regressions
exercise mixed saved/unsaved results with filters, regex, pagination, and output
modes; successive edits, save, and revert; same-named dirty files in multiple roots;
and per-file/aggregate snapshot budgets with recovery. Oversized snapshots return
an explicit error without partial results or a stale disk fallback. The remaining
unsaved-buffer contract in `GlyphIdeContext.test.mjs` concerns future semantic and
symbol retrieval, which lexical-search coverage does not establish.

`GlyphChats.test.mjs` covers the two rank-3 contracts and their switching/error
regressions. Chats are created through the UI using the production runtime. The
tests switch between persisted conversations, recover the selected chat after
reload and host restart, preserve separate in-memory drafts while switching, and
verify that background completions do not steal selection. Account tests use
`scriptedAccounts` to provide distinct fabricated credentials and model catalogs;
the recorded request identifies the selected fixture account and model. An empty
catalog leaves the draft intact. Fixture account arrays use Playwright's
`[accounts, { scope: 'test' }]` option syntax.

`GlyphProgress.test.mjs` contains the three rank-2 contracts: streaming reasoning
summaries and tool activity, all five conversation token counters, and cumulative
usage across turns and reconnects. It exercises real file reads and a waiting
question tool, cancellation, renderer reload, and utility-host restart. Completed
turns persist compact tool summaries and usage atomically with their transcript.
Totals count reported usage for saved, completed turns; failed or interrupted
turns are excluded, and older or unreported turns are explicitly marked as missing
usage. Reconnect replaces totals instead of adding them again. Cached input and
reasoning tokens remain included in input and output respectively.

`GlyphRecovery.test.mjs` contains the executable rank-1 contracts: partial-answer
recovery after renderer reload, interrupted-answer diagnostics and durable
history after utility-host failure, and preventing a second window from running
another agent against the owner's files. These tests use the scripted provider
through the production runtime. Renderer disconnect cancels its running answer;
reconnect restores the retained partial text without automatically resending it.
A utility-host crash restores completed durable turns; uncheckpointed streaming
text is not durable and the interrupted provider request is not automatically retried.

Code OSS's "Duplicate As Workspace in New Window" creates a distinct workspace
identity with overlapping roots. The Electron ownership case verifies that this
window is denied agent execution while preserving its draft and the owner's
running turn. Same-identity read-only peers are additionally covered by the host
unit tests; overlapping workspace identities do not inherit each other's chats.

`GlyphWorkbench.test.mjs` is the executable coverage inventory. Its descriptions
state user-visible behavior, including native sidebar discovery, complete and
partial responses, keyboard submission, multiline input, empty submissions,
literal markup, draft/focus preservation during streaming, stable response DOM
identity, cancellation and reuse, successive turns, window reload and
conversation restoration, workspace trust, overlapping workspace ownership, and
production startup without an account.

`GlyphProposals.test.mjs` exercises the text proposal review contracts through the
scripted provider and production editor adapter: pending previews, per-item and
per-file Keep/Undo, accepted/rejected receipts in the next provider request,
invalid ranges and revisions, Unicode/CRLF preservation, explicit EOL conversion,
normal editor Undo, and review restoration after reload. These replace the text
proposal placeholders formerly in `GlyphToolCalls` and `GlyphWorkbench`.

The pending groups use `it.fixme` deliberately (`it` aliases Playwright's test API).
Those descriptions are visible in test discovery and reports, but they are
specifications, not passing tests. Remaining groups cover additional tools,
attachments, structural file proposals, and additional agent capabilities.
Enable a pending contract when the user-facing feature exists, then replace the
empty body with interactions and assertions. Hidden-service calls do not satisfy
the black-box contract.

`GlyphIntegratedBrowser.test.mjs` specifies opening web links inside Glyph and
browser navigation and lifecycle controls. `GlyphBrowserAnnotations.test.mjs`
breaks down DOM hover highlighting and selection, Alt/Option-click placement at
exact document coordinates, numbered comment bubbles with reopening and editing,
and anchor behavior across layout changes, navigation, and reloads. DOM comments
follow their selected element; position comments retain their document coordinates.
These pending UI contracts complement the agent-driven CDP tool contracts in
`GlyphBrowserAutomation.test.mjs`. Use isolated local fixture pages when enabling
them; the placeholders do not establish browser or annotation functionality.

The roadmap groups also specify chat annotations, editor Tab completion, inline
proposal rebuttals, queue/interrupt/steer controls, compaction, usage metering,
settings, language-server context, and user-authorized cross-chat communication.
Hook cases name each lifecycle event and its permitted effects, including
non-blocking notifications, approvals, input rewrites, and MCP-only result
replacement. These are acceptance contracts, not implemented hooks or evidence
of coverage. The existing active-turn draft test describes today's behavior;
queue/interrupt/steer contracts describe its planned replacement.

## Failure evidence

Every executed test retains Electron output and Code OSS logs under
`.artifacts/code-oss-integration/results`. Failures and retries also retain a
Playwright trace and final screenshot; clean passes do not duplicate large trace
archives in the report and evidence artifact. Explicit test screenshots remain.
The HTML report is `.artifacts/code-oss-integration/report/index.html`, and
`results.json` provides machine-readable passed/failed/skipped counts. These
directories are already excluded through the repository's `.artifacts/` rule.
Playwright replaces the previous run's report, so copy evidence elsewhere before
starting another run if it must be retained.

Tests run with the worker count in `playwright.config.mjs` (two workers in CI)
and one retry. First-attempt failures and retries remain in the reports.
The fixture response delay is set to 80 ms per chunk so streaming and cancellation
can be observed through the UI. Tests wait on visible conditions rather than
using fixed sleeps.

Each launch uses an empty, isolated extensions directory. There is no blanket
`--disable-extensions` flag: it disables only user extensions (none are installed
in the fixture), while introducing a delayed urgent notification that can close
the popovers under test. Built-in extensions remain available in either case.
Headless Linux CI installs `trash-cli` and selects Electron's supported trash
backend so delete, Revert, and Undo exercise recoverable deletion without a
desktop session. Sandbox lifecycle checks translate isolated Linux PIDs into
host PIDs within the fixture application's descendant tree before observing exit.
