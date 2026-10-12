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

The `[review-NN]` cases are ordinary executable tests asserting correct behavior.
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

The `[round2-NN]` cases (and Rust's `round2_01` case) were first run against
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
pnpm exec vitest run --maxWorkers=1 -t '\[round2-'
cargo test --package glyph-context-index round2_01
pnpm code-oss:test:aliases
pnpm code-oss:test:integration --grep '\[round2-'
```

The peer test bundles the real workbench client with a simulated MessagePort.
The production crash case uses an empty isolated account store, not live credentials.
Account ownership now uses a SQLite OS lock, released automatically on process
death; legacy sentinel directories are removed only after their recorded PID is
confirmed absent. Shell regressions simulate process events and signals, not
native sandbox enforcement.

### Third-round regressions

The `[round3-NN]` regressions reproduced all five findings before their fixes:

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

The `[round4-NN]` tests reproduced the three findings before their fixes:

- Editor mutations now pass an operation-scoped cancellation token to Bulk Edit. Folder changes, invalidation, and disposal cancel prepared writes. A write that completed before revocation retains its receipt, which remains inspectable without reading the removed workspace. Tests separately gate preparation and completion, including Code OSS's non-authoritative `isApplied` flag.
- Invalid shell wake patterns release newly allocated terminal slots; repeated failures no longer exhaust capacity.
- Bulk proposal acceptance honors the workspace's case-sensitivity policy, allowing distinct `foo.ts` and `Foo.ts` resources on a case-sensitive store.

Editor regressions are in [GlyphEditorAdapter.test.mjs](../scripts/code-oss/tests/GlyphEditorAdapter.test.mjs); shell and proposal regressions are in their respective `ShellSessionManager` and `ProposalReviewManager` test suites. Folder changes still require a reload to establish a new host/editor binding.

The acknowledged editing-workflow blockers remain explicit fixmes:

- Question and approval forms and proposal decision controls: `Pending desktop product contracts` in [GlyphWorkbench.test.mjs](tests/electron/GlyphWorkbench.test.mjs).
- Structural create/delete/rename review and application: the structural mutation, Create File, and Delete File groups in [GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs).
- Dirty-buffer content search suppressing stale disk matches: `Pending Search Contents` in [GlyphToolCalls.test.mjs](tests/electron/GlyphToolCalls.test.mjs).

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
the Preact root with the pane. Components own draft state and reconcile keyed
transcript rows, preserving DOM identity while response text streams in.

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
