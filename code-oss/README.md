# In-repository Code OSS integration

Glyph pins Code OSS `1.141.0` at commit
`2a59476c9bfcb90b3ddc372c36762471b7dfad1c`. The upstream tree is generated
inside this repository rather than maintained as a second Git repository:

```sh
pnpm code-oss:bootstrap
pnpm code-oss:install
pnpm code-oss:compile
pnpm code-oss:launch -- --user-data-dir ../user-data --extensions-dir ../extensions
```

`code-oss/overlay/` contains every Glyph-owned upstream addition.
`scripts/code-oss/apply-overlay.mjs` also makes the deliberately small entry
point and product-identity changes. Re-running it is idempotent.
The runner installs the pinned Node runtime under ignored `.code-oss/` and then
uses upstream's npm lockfile; Glyph's root remains a pnpm workspace.

Overlay imports use `#vs/*` for Code OSS modules and `#glyph/*` for Glyph's shared
protocol and workbench state. For example, `#vs/base/common/uri.js` resolves to
the upstream URI module, and `#glyph/protocol/editor/GlyphEditorRequest.js`
resolves to the shared editor request contract. Nearby feature imports may stay
relative within the same directory; cross-directory feature imports use `#vs/*`.

`code-oss/tsconfig.json` supplies IDE navigation and overlay typechecking. Its
paths prefer Glyph-owned overlay modules, then fall back to the pinned generated
tree. Run `pnpm code-oss:apply` after adding shared protocol/state files so that
fallback stays current. Bootstrap and install are required for upstream types.

Overlay generation resolves these same aliases into relative ESM imports before
upstream compilation. The built renderer and Electron main therefore need no
runtime alias loader, import map, or root Glyph package. This lowering covers
imports, re-exports, import types, and literal dynamic imports; unrelated strings
and comments are untouched. Unknown aliases fail the build.

`pnpm code-oss:check:overlay` checks the editable source, and
`pnpm code-oss:test:aliases` checks alias lowering. The normal compile command
applies the overlay and typechecks it before compiling the workbench.
Alias tests use a separate configuration because resolution parity needs the
bootstrapped upstream tree; Glyph's standalone unit tests do not.

Build the host artifact with `pnpm desktop:artifact`. The resulting archive
under `.artifacts/` contains emitted JavaScript and declarations, production
dependencies, both Rust helpers, a source/protocol manifest, and per-file
checksums. A successful terminal Node build is not treated as ABI evidence:
the Electron integration fixture exercises `better-sqlite3`, the index helper,
and the native sandbox inside the utility process.

Normal launches compose Glyph's existing account, provider, chat persistence,
proposal-review, and sandbox services in the utility host. Reads and text edits
use renderer RPC to the live Code OSS models. Accounts come from Glyph's
configured state directory; the sidebar currently uses the first available
inference account/model when starting a conversation.

The workbench service projects snapshots, questions, approvals, tool activity,
usage, and proposals and exposes their interaction commands. The Preact sidebar
currently renders the transcript and composer. Account selection, human-decision
forms, and proposal controls remain follow-up components.
Structural file mutations are not yet supported by the editor-backed text
store, and indexed content search still reads disk rather than merging dirty
buffers. These are product gaps, not capabilities proved by the smoke fixture.

`pnpm code-oss:test:integration` runs the Playwright Electron suite against the
compiled application with isolated profiles and workspaces. Most cases select
the deterministic runtime explicitly with `GLYPH_DESKTOP_TEST_RUNTIME=deterministic`;
production-startup cases do not. Pending behavior tests describe unfinished
product workflows and are reported separately from passing tests. See
`code-oss/tests/electron/` for the coverage descriptions.

Run `pnpm code-oss:test:integration --list` to browse the behavior inventory:

- [GlyphWorkbench.test.mjs](tests/electron/GlyphWorkbench.test.mjs): runnable workbench flows and pending chat, editor, hook, and cross-chat workflows.
- [GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs): shell, project read/search, proposal, question, and reviewed file creation/deletion contracts.
- [GlyphAgentCapabilities.test.mjs](tests/electron/GlyphAgentCapabilities.test.mjs): Plan Mode, blocking/background sub-agents, action items, web fetch/search, and shell wake conditions.
- [GlyphBrowserAutomation.test.mjs](tests/electron/GlyphBrowserAutomation.test.mjs): CDP lifecycle, DOM inspection/highlighting, input, screenshots, and browser feedback.
- [GlyphMcp.test.mjs](tests/electron/GlyphMcp.test.mjs): human/agent installation and configuration, authentication, tool discovery/calls, resources/prompts, and optional or revision-dependent capabilities.
- [GlyphSkills.test.mjs](tests/electron/GlyphSkills.test.mjs): skill discovery, activation, progressive loading, human/agent management, and execution boundaries.
- [GlyphRules.test.mjs](tests/electron/GlyphRules.test.mjs): always-on, file-pattern, agent-selected, and manual rules with configuration and source visibility.
- [GlyphAgentsMd.test.mjs](tests/electron/GlyphAgentsMd.test.mjs): root/nested instruction discovery, scope, precedence, refresh, and reviewable edits.
- [GlyphIdeContext.test.mjs](tests/electron/GlyphIdeContext.test.mjs): active editors, exact selections, diagnostics/symbols, retrieval/indexing, context budgets, and privacy.

The capability files are explicit `it.fixme` inventories, not passing
integration coverage. Enabling them requires scripted provider tool calls through
the production runtime and observable workbench/browser/filesystem assertions.
Use isolated local fixtures rather than live providers, real browsing profiles,
or direct calls to internal Glyph services.

Format references for these contracts are the [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28),
[Agent Skills specification](https://agentskills.io/specification),
[Cursor rule activation modes](https://cursor.com/docs/rules), and
[AGENTS.md conventions](https://agents.md/). These are Glyph product targets,
not claims of complete compatibility with another IDE. Pin the protocol revision
and fixture capabilities when implementing an MCP case; extensions and legacy
features are kept separate from core support. Context/rule/skill cases should
assert the recorded provider input, not infer correct inclusion from a plausible
model response.

## Review regressions

The review regressions are ordinary executable tests with behavioral descriptions.
They reproduce the original defects and pass against the corrected implementations;
they are not `it.fails`, skips, fixmes, or unconditional failures.
The review's 11 findings map to these tests:

| Finding | Regression coverage                                                                           | Test file                                                                                        |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 01      | Case-insensitive exclusion of `.ENV` and `.GIT/config`                                        | [FileSystemWorkspaceTextStore](../src/workspace/tests/FileSystemWorkspaceTextStore.test.ts)      |
| 02      | Separate accounts refreshing concurrently; one shared account across workspace sessions       | [OpenAISession](../src/providers/openai/auth/tests/OpenAISession.test.ts)                        |
| 03      | Applied edits retain accepted receipts after two checkpoint failures, reject-all, and restart | [ProposalReviewRecovery](../src/editing/reviews/test/ProposalReviewRecovery.adversarial.test.ts) |
| 04      | Existing provider callbacks use replacement sign-in credentials                               | [OpenAIBackend](../src/providers/openai/tests/OpenAIBackend.test.ts)                             |
| 05      | Host exit releases an active send and subsequent sends acquire a live connection              | [GlyphReviewRegressions](tests/electron/GlyphReviewRegressions.test.mjs)                         |
| 06      | Abandoned ownership expires and its runtime is disposed                                       | [GlyphDesktopHost](../src/desktop/host/tests/GlyphDesktopHost.test.ts)                           |
| 07      | Symlink aliases cannot establish two mutation owners                                          | [DesktopHostPrimitives](../src/desktop/host/tests/DesktopHostPrimitives.test.ts)                 |
| 08      | Close and dispose escalate cleanup after parent exit while descendants retain pipes           | [ShellCleanup](../src/shell/test/ShellCleanup.regression.test.ts)                                |
| 09      | Narrow reads and attachments enforce limits before loading the whole file                     | [ProjectReadBudgets](../src/project/tests/ProjectReadBudgets.regression.test.ts)                 |
| 10      | Account and workspace-ownership rejection preserve unsent drafts                              | [GlyphReviewRegressions](tests/electron/GlyphReviewRegressions.test.mjs)                         |
| 11      | Human titles survive send, context, and reset checkpoints and reload                          | [ChatSessionManager](../src/chat/sessions/test/ChatSessionManager.test.ts)                       |

Run just the reviewed regressions with:

```sh
pnpm exec vitest run --maxWorkers=1 -t '\[review-'
pnpm code-oss:test:integration GlyphReviewRegressions
```

The shell cleanup case simulates child events and intercepts all process signals.
The Electron crash case kills only the named Glyph utility child discovered via
the isolated test application's process metrics. Credentials are fabricated, and
file tests use disposable canaries and tiny size limits. The abandoned-owner test
allows a bounded reconnect grace period (five minutes of virtual time), not an
indefinite claim on the workspace.

Disconnected windows retain ownership for a 30-second reconnect grace period.
After that, the host stops the abandoned runtime before granting replacement
authority, including when the original runtime was still initializing.

### Second-round regressions

The cases below were first run against
the unfixed implementation and failed, then rerun against the fixes. They cover:

| Finding | Regression coverage                                                                                          | Test file                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01      | Native search applies case-insensitive sensitive-file exclusions                                             | [Native index service](../native/context-index/src/service.rs)                                                                                      |
| 02      | A pending, subsequently failed text mutation exposes no accepted receipt                                     | [ProposalReviewRecovery](../src/editing/reviews/test/ProposalReviewRecovery.adversarial.test.ts)                                                    |
| 03      | Snapshot capture cannot overwrite a newer completed-run event                                                | [GlyphDesktopHost](../src/desktop/host/tests/GlyphDesktopHost.test.ts)                                                                              |
| 04      | Delayed earlier credential saves cannot overwrite newer account tokens                                       | [FileOpenAIAccountStore](../src/providers/openai/auth/tests/FileOpenAIAccountStore.regression.test.ts)                                              |
| 05      | Failed token persistence is retried before another workspace reuses the token                                | [OpenAISession](../src/providers/openai/auth/tests/OpenAISession.test.ts)                                                                           |
| 06      | Dead legacy locks are reclaimed, live owners stay exclusive, and the production host restarts after a crash  | [Account lock](../src/providers/openai/auth/tests/FileOpenAIAccountStore.test.ts), [Electron crash](tests/electron/GlyphReviewRegressions.test.mjs) |
| 07      | An attached peer reattaches over its existing transport after its owner disappears                           | [GlyphDesktopClient](../scripts/code-oss/tests/GlyphDesktopClient.test.mjs)                                                                         |
| 08      | Close and dispose retain SIGKILL escalation after the parent and its pipes close                             | [ShellCleanup](../src/shell/test/ShellCleanup.regression.test.ts)                                                                                   |
| 09      | Aggregated search stays within its byte budget and resumes at the first omitted match                        | [MultiRootWorkspacePathIndex](../src/context/search/tests/MultiRootWorkspacePathIndex.test.ts)                                                      |
| 10      | Small dirty buffers remain readable over oversized disk files without bypassing exclusions or symlink checks | [OpenAIDesktopRuntimeFactory](../src/desktop/host/tests/OpenAIDesktopRuntimeFactory.test.ts)                                                        |

```sh
pnpm exec vitest run --maxWorkers=1 src/desktop/host/tests src/providers/openai/auth/tests src/context/search/tests
cargo test --package glyph-context-index scan_excludes_sensitive_names_using_filesystem_case_policy
pnpm code-oss:test:aliases
pnpm code-oss:test:integration GlyphReviewRegressions
```

The peer test bundles the real workbench client with a simulated MessagePort.
The production crash case uses an empty isolated account store, not live credentials.
Account ownership now uses a SQLite OS lock, released automatically on process
death; legacy sentinel directories are removed only after their recorded PID is
confirmed absent. Shell regressions simulate process events and signals, not
native sandbox enforcement.

### Third-round regressions

These regressions reproduced all five findings before their fixes:

| Finding | Regression coverage                                                                                                     | Test file                                                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 01      | Shell sensitive-file policy and automatic approval reject differently cased secret filenames                            | [Sandbox policy](../native/shell-sandbox/src/lib.rs), [Shell classifier](../src/shell/test/ShellCommandAuthorizer.test.ts) |
| 02      | Rejection, bulk rejection, and acceptance receipts stay unpublished until their checkpoint succeeds                     | [ProposalReviewRecovery](../src/editing/reviews/test/ProposalReviewRecovery.adversarial.test.ts)                           |
| 03      | Folder changes cannot redirect an existing host path to a nested namesake                                               | [GlyphEditorAdapter](../scripts/code-oss/tests/GlyphEditorAdapter.test.mjs)                                                |
| 04      | Search returns its completed page at the maximum offset without fetching an invalid next page                           | [MultiRootWorkspacePathIndex](../src/context/search/tests/MultiRootWorkspacePathIndex.test.ts)                             |
| 05      | Foreground commands return immediately when the process group is absent; surviving descendants still receive escalation | [ShellCleanup](../src/shell/test/ShellCleanup.regression.test.ts)                                                          |

Workspace-folder changes currently detach Glyph and require a window reload to
establish a new host/editor binding. Requests against the old binding fail closed
with `WORKSPACE_CHANGED`, including reads or mutations already awaiting editor
work. Automatic rebinding is tracked in the IDE-context fixmes.

Shell matching is deliberately case-insensitive on every platform. These tests
inspect policy construction and simulate process events; they do not execute a
sandbox bypass or establish native enforcement evidence.

### Fourth-round regressions

These tests reproduced the three findings before their fixes:

- Editor mutations now pass an operation-scoped cancellation token to Bulk Edit. Folder changes, invalidation, and disposal cancel prepared writes. A write that completed before revocation retains its receipt, which remains inspectable without reading the removed workspace. Tests separately gate preparation and completion, including Code OSS's non-authoritative `isApplied` flag.
- Invalid shell wake patterns release newly allocated terminal slots; repeated failures no longer exhaust capacity.
- Bulk proposal acceptance honors the workspace's case-sensitivity policy, allowing distinct `foo.ts` and `Foo.ts` resources on a case-sensitive store.

Editor regressions are in [GlyphEditorAdapter.test.mjs](../scripts/code-oss/tests/GlyphEditorAdapter.test.mjs); shell and proposal regressions are in their respective `ShellSessionManager` and `ProposalReviewManager` test suites. Folder changes still require a reload to establish a new host/editor binding.

### Fifth-round regressions

These regressions first reproduced these failures:

- A saved workspace can reopen after its folders change even when the previous configuration has pending reviews. Desktop checkpoints now live under their exact mutation scope. Matching legacy checkpoints are copied into scoped storage; the legacy file is preserved, and empty scoped checkpoints prevent settled reviews from being imported again. Restoring the original folders restores their pending reviews. Corrupt checkpoints and foreign checkpoints inside an already scoped directory still fail closed.
- The editor receipt hashes the actual model change, identified by its edit source, rather than predicting the resulting bytes from the replacement request. The regression uses the pinned Code OSS text model with pending automatic whitespace and verifies both successful application and the resulting receipt hash.
- A rejected command cannot change a running terminal's wake condition. The new condition is installed only after command admission and successful process launch.

Coverage lives in the `OpenAIDesktopRuntimeFactory`, `FileProposalReviewStore`, `GlyphEditorAdapter`, and `ShellSessionManager` tests. The factory test uses real checkpoint initialization with provider initialization stubbed; no live account or provider is required.

### Sixth-round regressions

These regressions reproduce and guard three additional failures:

- Desktop chat identity depends on the Electron profile/workspace container, not its folder count. Existing chats under the old single-folder identity migrate atomically into the stable catalog, preserving chat IDs, transcripts, and provider state. Review and shell-permission storage retains its existing locations and mutation-scope checks.
- When a send fails after the user starts another draft, the original appears under **Unsent messages**. Editing it swaps it with the current draft, preserving both; nothing is automatically retried or queued. If there is no newer draft, the failed message returns directly to the composer. Component tests run the actual Preact view in headless Chromium.
- Wake subscriptions and partial matches are command-scoped. Reusing a terminal without `wake_on` clears the previous condition; rejected commands still leave the running command's condition untouched.

### Seventh-round regressions

The TypeScript and Rust cases first reproduced the eleven
review findings and the additional runtime-disposal race:

- Revoking workspace trust drains the owning runtime, including active turns and background shells, before attaching an untrusted replacement. Mutating commands remain blocked until trust is restored.
- Index-worker stdin errors enter the same cleanup path as process failures, rejecting pending requests without an unhandled stream error.
- Proposal acceptance rebases remaining hunks against the editor's actual returned text, including normalized line endings. Patch compilation resolves all source spans against the original revision before applying replacements.
- CLI review storage uses the workspace mutation scope, and activating a cached chat synchronizes the global trace setting.
- Native searches reject regex offsets inside UTF-8 codepoints, budget context before copying it, and bound per-worker result queues. Tests use small fixtures, not memory-exhaustion stress probes.
- Rejected raw shell input cannot replace a wake subscription. Account-specific wakes remain queued until their owning chat durably records them.
- Terminal Page Up and Page Down make clipped transcript history reachable; paging to the bottom resumes following streamed output.
- Runtime disposal waits for admitted commands, including proposal decisions, before closing chat storage.

Host, runtime, shell, proposal, and terminal regressions use controlled dependencies
or disposable filesystem fixtures. The CLI test checks composition wiring; the
review-store tests exercise scoped checkpoint reopening. Native search tests cover
the UTF-8 boundary and context-budget behavior directly. These are not evidence of
native shell-sandbox enforcement or completed desktop review controls.

### Eighth-round regressions

These regressions cover the next eleven findings:

- Shell approval dedicates the terminal to a paged command viewport with fixed decision controls. Page Up/Down belongs to that panel while it is open; background-shell summaries return afterward. Approval is disabled when the terminal is too small to review the panel.
- Successfully observed workspace mutations remain in memory after checkpoint failures. The next queued operation must persist them before it can change a decision; normalized editor text is not compared back to an obsolete prediction.
- Desktop routing uses a single-component identifier shared by the host and editor. Safe unique folder names retain their existing addresses; duplicate or delimiter-containing display names use URI-derived identifiers. Display labels remain separate.
- Attachment search generations survive prompt remounts. Replacement native workers start with clean transport buffers and ignore late output from the old worker.
- Large-file review calculates line-number width iteratively. Rename proposals retain BOM-only decisions, and acceptance applies both changes.
- Explicit EOL conversion of existing multiline editor content fails before mutation until the editor port supports an undoable EOL operation. Newline normalization for inserted text remains supported; unsupported conversions cannot silently settle as accepted.
- Trust changes hydrate the selected chat after the new runtime snapshot. Transcript paging resets for a different conversation, and cursor placement follows Ink's hard-wrap behavior for wide characters.

Coverage includes controlled transport/workbench fixtures, real terminal rendering,
and disposable proposal/recovery fixtures. No approval fixture executes its displayed
command. The EOL limitation has a dedicated Electron FIXME in
[GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs).

### Ninth-round regressions

These regressions cover the next ten findings:

- Successful editor mutations keep their accepted receipts even when automatic whitespace cleanup conflicts with a remaining hunk. The observed document and stale remaining review survive checkpoint reload; rejection cannot relabel the applied edit.
- UTF-8 decoding removes only the encoding BOM, preserving a literal leading U+FEFF in document text and subsequent replacements.
- Compatible unique root names, including spaces and Unicode, retain their mutation identity and existing review checkpoints. Generated routing identifiers avoid collisions with friendly names. Valid shell permissions from a different root scope grant no authority and no longer prevent a fresh approval; malformed policies still fail closed.
- A background wake runs in its owning chat, then restores the user's original conversation before allowing the preserved draft to submit.
- Review rendering appends large line collections iteratively in both focused and full-file modes. Mixed-EOL changes that normalize entirely away fail before mutation rather than creating an accepted no-op receipt.
- Background terminal summaries are compact and height-bounded. The composer follows its caret within a bounded viewport, and completion lists keep the highlighted entry visible. Question forms scroll to the highlighted option; Page Up/Down navigates the form instead of the transcript, with confirmation help outside the scrolling body.

Coverage uses disposable filesystem/checkpoint fixtures, controlled editor adapters,
and rendered terminal interactions. Background-panel fixtures do not execute shell
commands. Desktop EOL conversion remains unsupported until its explicit editor
operation is implemented; this round does not claim to implement the pending
desktop question, proposal, or structural-edit UI.

### Tenth-round regressions

The trust, matcher, and question-viewport regressions were first observed failing
against the previous implementation, then rerun against the fixes:

- `GlyphTrustSynchronization.test.mjs` connects the actual workbench service,
  client, and host over a fixture transport. Trust changes during the handshake
  or attach acknowledgement are synchronized before runtime commands proceed;
  restoring trust allows subsequent sends.
- The native index test `settles_an_unpublished_query_when_the_next_generation_repeats_it`
  reproduces an interrupted matcher state and verifies that repeating the query
  publishes the new results instead of returning the previous snapshot.
- The question-viewport regression renders a long question through the terminal root. Page Up/Down
  scroll the prompt independently, arrow navigation reveals the selected choice,
  and Enter reveals an offscreen choice before allowing confirmation.

The formerly failing Storybook import guard is also fixed. Its shared UI and
fixture imports use `#code-oss`; both TypeScript and the static Vite build resolve
that alias. These checks do not exercise live providers or native sandbox enforcement.

### Eleventh-round regressions

These cases failed before their fixes and cover:

- Shutdown while a background wake is being persisted, while its request is
  being prepared, and during inference. No new turn starts after shutdown;
  an active turn receives shutdown cancellation without relying on an interrupt
  handler to find its request controller.
- Tool-error codes, messages, and nested details are sanitized before plain
  output or Ink rendering. The Ink test compares styled frames rather than
  stripping ANSI sequences and concealing an injected color.
- Fuzzy-match positions stay in Unicode code-point coordinates when an emoji
  workspace prefix is added, for both routed and cross-root queries.

These tests use in-memory dependencies and harmless control-character markers;
they do not call providers or execute shell commands.

### Twelfth-round regressions

These cases reproduce and cover:

- Failed completion checkpoints remain visible, block review-result delivery,
  and retry on `R` or review reopening without applying the edit twice. Terminal
  sends also flush outstanding review results before requesting another turn.
- The window-scoped workbench service owns composer drafts, recovered messages,
  and pending-send state. Pane disposal does not discard them; failures settling
  while the pane is unmounted still recover the original message. This does not
  persist drafts across application shutdown or window reload.
- Background wake matching retains terminal-control parser state across output
  chunks, separately for stdout and stderr and freshly for each command.
- File-listing cancellation reaches the native index, and turn cancellation or
  timeout interrupts credential waiting without cancelling a shared refresh.

Coverage uses controlled persistence failures, rendered production components,
inert shell streams, and deferred credentials. It does not require live providers.

The acknowledged editing-workflow blockers remain explicit fixmes:

- Question and approval forms and proposal decision controls: `Pending desktop product contracts` in [GlyphWorkbench.test.mjs](tests/electron/GlyphWorkbench.test.mjs).
- Structural create/delete/rename review and application: the structural mutation, Create File, and Delete File groups in [GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs).
- Dirty-buffer content search suppressing stale disk matches: `Pending Search Contents` in [GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs).
- Desktop background-shell wake delivery: `Pending background shells with agent-configured wake conditions` in [GlyphAgentCapabilities.test.mjs](tests/electron/GlyphAgentCapabilities.test.mjs).

### Authentication lifetime, text fidelity, and bounded rendering

Regression coverage now includes refresh completion after logout/shutdown,
NUL rejection before proposal staging or filesystem mutation, literal leading
U+FEFF in real editor models, rejection of unbound remote workspace URIs, and
distinct Unicode filenames without unconditional normalization.

Project reads cap serialized results at 512 KiB, including numbered text and
line metadata. A `nextStartLine` cursor identifies the next page; a single line
that cannot fit is rejected explicitly. Review paging uses single-row status
and keyboard hints so narrow terminals can reach the final change. Question
cursors style complete Unicode code points. Failed upstream installs unwind
through Git-hook cleanup before returning the subprocess exit status.

The tests use deferred authentication, disposable files, the pinned editor text
model, real Ink rendering, and an inert installer subprocess. These checks do
not establish live-provider behavior or native sandbox enforcement.

### Shared credentials and review correctness

Shared refresh work follows the application-owned account store, so disposing
one workspace does not discard another workspace's rotated credentials. Store
shutdown invalidates outstanding refreshes and drains started saves before
releasing the credential lock.

Reviews recover unsupported current file types as stale instead of blocking
startup. The terminal diff shows controls as visible symbols (`␛` for ESC),
literal text U+FEFF as `⟨U+FEFF⟩`, and BOM changes as encoding metadata. Proposal
compilation and filesystem writes reject unpaired UTF-16 surrogates rather than
silently replacing them. Autocomplete only selects results bound to the current
mention and index. Search retains its final valid page at the offset ceiling;
`truncated: true` with `nextOffset: null` means callers must narrow the query.

### Continuations, trust, and bounded workspace operations

Runtime hardening also covers long-lived turns and trust transitions. Every
model continuation resolves current credentials; shell input succeeds only
after its pipe write is acknowledged and failed writes preserve wake settings.
Untrusted runtimes load persisted chats/reviews without project reconciliation
or indexing. Granting trust recreates the runtime and reconciles before allowing
mutations; overlapping attachment changes are serialized by the host.
Retired connections and host shutdown invalidate queued attachments, preventing
vanished windows from recreating runtime ownership.

Interrupted rename destinations that become unsupported resources stay stale
and rejectable. Diff deadlines are enforced inside matching, and oversized
replacements are rejected before diffing. Native content reads are bounded on
the opened descriptor; Unix additionally rejects replacement symlinks, detects
changed file identity, and opens nonblocking to avoid FIFO hangs. These Unix
checks do not establish equivalent Windows path-race protection. An incomplete
index retains its warning without suppressing results from later workspace roots.
Cancelled proposal preparation cannot proceed to diffing or staging after an
outstanding read completes; already-dispatched checkpoint writes still finish
and report their durable result.

### Recovery, cancellation, and collision checks

Failed attachments superseded by a newer trust or folder configuration retry
that configuration on the same live connection. Model discovery carries caller,
backend, and credential-owner cancellation through to HTTP; cancelling one
workspace does not cancel a peer's shared credential refresh.

CREATE and rename collision checks use metadata, including live unsaved editor
models. Proposal compilation and review recovery bound content reads by the
configured resulting-file plus changed-byte budgets, with three bytes allowed
for a source BOM that the edit removes. An oversized recovery file
remains stale and rejectable; it cannot establish that an interrupted mutation
succeeded. Structural editor mutations remain unsupported.

## Native Preact view

`code-oss/ui/` owns the JSX components and scoped stylesheet. Its separate
TypeScript configuration uses Preact's JSX runtime without changing the
terminal's React/Ink configuration or Code OSS's compiler. Shared workbench
state lives in `src/desktop/workbench/` and is copied into the generated tree.

`pnpm code-oss:compile` typechecks the UI and reapplies the overlay before
compiling upstream. Overlay generation bundles Preact and the components into
one local browser ESM module plus CSS, so the application needs no CDN, webview,
or runtime package resolution. Do not edit those generated bundles.

`GlyphViewPane` mounts the view, forwards service state/actions, and disposes
the Preact root with the pane. The window-scoped service owns composer state;
components reconcile keyed transcript rows, preserving DOM identity while
response text streams in.

### Browser iteration with Storybook

Run the Preact UI directly in a browser without bootstrapping, building, or
launching Code OSS:

```sh
pnpm install
pnpm storybook
```

Open http://127.0.0.1:6006 and start with **Glyph / Workbench / Interactive**.
Send a message to simulate a streaming reply, type another draft while it
streams, or cancel the reply. Everything stays in memory; these stories use
fabricated state and never connect to accounts, models, or the desktop host.
Edits to `code-oss/ui/` refresh the browser through Vite.

The toolbar switches between light/dark themes and 280px, 360px, and 600px pane
widths. Workbench, composer, and transcript stories also cover empty state,
attached selections, a fixed streaming state, send failures, and long scrolling
conversations. In **Send Failure**, submit a draft to see the error and draft
restoration. Fixed stories use inert callbacks; use **Interactive** for send and
cancel behavior.

Stories live beside their components in `code-oss/ui/`; shared fixtures and
preview configuration live in `code-oss/storybook/`. The stories import the
production components and CSS. The preview stylesheet approximates the native pane's
inherited theme variables and typography. Check native styles, workbench
shortcuts, editor selection, pane lifecycle, and host communication in Code OSS.
Storybook does not implement the currently missing account/approval/proposal UI.

```sh
pnpm code-oss:check:storybook
pnpm storybook:build
```

The static build goes to ignored `.artifacts/storybook/`. Storybook's Vite
configuration resolves `#src` and `#code-oss` to editable source and uses a separate Preact
TypeScript configuration; it does not change the terminal's React runtime or
the production esbuild bundle. Storybook is pinned to 10.6.1. Its Preact renderer
still declares a Preact 8/10 peer range, so installation reports a peer warning
with our Preact 11; verify browser rendering and interactions when upgrading.
The renderer also requests the optional `@storybook/react-dom-shim` during
dependency optimization, which produces a startup warning in this setup without
the Docs addon. The component previews do not use that shim.

## Upstream-host decision

At the pinned revision, Code OSS's agent host owns its own session protocol,
side-effect bookkeeping, provider lifecycle, and state projection. Adapting
Glyph to that protocol would make a second state system authoritative for
staged-before-write proposals, approvals, and recovery. This integration
therefore reuses the upstream `UtilityProcess` and MessagePort lifecycle
patterns, but keeps a dedicated versioned Glyph protocol and Glyph's existing
domain state.

## Patch inventory

- `src/vs/workbench/workbench.desktop.main.ts`: one import for the Glyph desktop contribution.
- `src/vs/code/electron-main/app.ts`: one import and one application-owned host-starter registration.
- `product.json`: application name, bundle/protocol identifiers, isolated data directories, and Open VSX gallery.
- `src/vs/platform/glyph/**`: serialized protocol and utility-host lifecycle.
- `src/vs/workbench/contrib/glyph/**`: native service, sidebar, live-model adapter, and review UI.

The bootstrap rejects a changed archive checksum or a mismatched generated
revision before applying the overlay.
