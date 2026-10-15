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

The pending groups use `it.fixme` deliberately (`it` aliases Playwright's test API).
Those descriptions are visible in test discovery and reports, but they are
specifications, not passing tests. Remaining groups cover additional tools,
usage metering, attachments, proposals, and guarded editing/Undo.
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
