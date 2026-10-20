# Glyph integration with Code OSS

Build Glyph as a desktop editor fork of `microsoft/vscode`, with its own native workbench interface and the existing harness running in a managed background process. The workbench is VS Code's application UI: its sidebars, editor groups, panels, commands, and layout. We will own that source and can change all of those surfaces.

This gives us a practical route toward the product we want. We retain the editor, language tooling, debugger, terminal, settings, and extension host, while making Glyph a built-in part of the application. Our chat, context selection, inline interactions, and edit review use internal workbench and editor services. They do not run as an extension or inside an extension webview.

The next milestone should demonstrate that this architecture works through the entire editing workflow. A user must be able to open a project, ask about unsaved code, receive a proposed change, review it inside the editor, accept it into the buffer, undo it, and recover after a window reload. A packaged application must run that workflow without this source checkout.

Research baseline: October 7, 2026; Glyph commit `2c10835`. Upstream references describe the inspected `main` branch and official documentation. The implementation must select a released upstream tag and record its exact commit before using these paths; private workbench APIs are not stable contracts. This is an implementation proposal, not a claim that the fork has already been built.

## How the pieces fit together

There are three parts to understand before considering individual files.

**Code OSS supplies the editor application.** It is the open-source repository behind VS Code. We fork that repository and build our own executable. Its internal contribution system lets built-in features register views, actions, menus, keybindings, and services. Despite the word “contribution,” this is ordinary application source, distinct from the public extension API. [Upstream source organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)

**Glyph remains the agent engine.** It owns conversations, provider protocols, tool execution, staged proposals, and decisions. It should continue to work from the terminal as well. Moving it into an editor does not require rewriting `AgentRuntime` or turning our conversations into Copilot conversations.

**A desktop adapter connects the two.** The editor sends user intentions to Glyph and renders its responses. When Glyph needs workspace text or applies or reverts a change, the adapter talks to the editor's document models. A document model is the live text in memory, including changes that have not been saved to disk. This adapter is the most consequential new code.

| Location                                         | Responsibilities in the proposed product                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Workbench window, in Electron's renderer process | Glyph sidebar, composer, transcript, context chips, review UI, editor decorations, document snapshots, version-checked edits, undo |
| Electron main process                            | Start and stop the Glyph host; connect authorized windows to it; participate in application shutdown                               |
| Glyph host, in an Electron utility process       | Account lifecycle, conversations, model requests, tools, proposal state, persistence, request routing                              |
| Glyph native subprocesses                        | Existing Rust index and sandboxed shell execution, launched by the host                                                            |
| Existing extension host                          | Ordinary editor extensions; independent of Glyph's implementation                                                                  |

A utility process is an application-managed background process with Node capabilities. Keeping inference, SQLite, filesystem work, and shell orchestration there protects editor responsiveness. It does not itself sandbox shell commands; the existing Glyph shell sandbox still supplies that boundary.

Communication uses Code OSS's process messaging infrastructure with explicit Glyph commands and events. There is no reason to expose a localhost HTTP server for this first desktop integration. The current upstream agent host already demonstrates a utility-process entry point and MessagePort communication. We can reuse those process patterns without inheriting its entire agent model. [Upstream agent host entry point](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/agentHostMain.ts)

For example, “Explain this selection” works as follows:

1. A native editor action captures the selected range, resource URI, current text, and document version.
2. The workbench sends a request to the Glyph host, bound to that window, workspace, account, and chat.
3. Glyph uses the existing provider and tool loop. Workspace reads return through the editor adapter so an unsaved buffer takes precedence over disk.
4. Ordered response events update the transcript. A proposal event opens our review UI using immutable before-and-after text.
5. Proposing a change immediately asks the owning editor window to apply and save a version-guarded mutation. The agent can run commands against those bytes and continue editing. Keep records the human decision; Revert applies a guarded inverse edit. The host retains review state and feeds decisions back to the originating conversation.

## What we reuse from this repository

The current design has already done much of the separation needed for a second host.

| Existing seam                                                                                                                                       | Desktop use                                           | Required work                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [GlyphService](../src/application/GlyphService.ts)                                                                                                  | Headless application operations                       | Extract its construction from the CLI and make shared resource ownership explicit      |
| [AgentRuntime](../src/chat/runtime/AgentRuntime.ts) and [AgentModelAdapter](../src/chat/runtime/AgentModelAdapter.ts)                               | Agent loop and provider protocol                      | Retain their responsibilities and existing behavioral tests                            |
| [ChatBackend](../src/chat/ChatBackend.ts)                                                                                                           | Accounts, authentication, models, provider creation   | Share account ownership safely across workspace runtimes                               |
| [ChatSession](../src/chat/sessions/ChatSession.ts) and [ChatSessionManager](../src/chat/sessions/ChatSessionManager.ts)                             | Persistent chats                                      | Add one live owner per chat and explicit interrupted-run presentation                  |
| [ChatResponsePart](../src/chat/ChatResponsePart.ts)                                                                                                 | Text, reasoning summaries, tools, diagnostics         | Wrap in ordered, serializable desktop events                                           |
| [EditProposalService](../src/editing/proposals/EditProposalService.ts) and [ProposalReviewManager](../src/editing/reviews/ProposalReviewManager.ts) | Proposal construction, decisions, conflicts, recovery | Add change notifications and editor mutation receipts                                  |
| [WorkspaceTextStore](../src/workspace/WorkspaceTextStore.ts)                                                                                        | Reads, applied edits, and reverts                     | Implement an editor-backed adapter and separate content identity from host concurrency |
| [WorkspacePathIndex](../src/context/search/WorkspacePathIndex.ts)                                                                                   | Discovery and context search                          | Combine disk results with unsaved document content                                     |
| [QuestionPresenter](../src/interaction/questions/QuestionPresenter.ts) and [ShellPermissionPresenter](../src/shell/ShellPermissionPresenter.ts)     | Interactive forms and approvals                       | Implement request/response presenters over process messaging                           |
| [ShellSessionManager](../src/shell/ShellSessionManager.ts)                                                                                          | Shell authorization and process lifecycle             | Present its state in the workbench and bind it to workspace/window lifecycle           |

The [CLI entry point](../src/cli.ts) currently constructs these objects alongside Ink components, terminal prompts, environment configuration, and paths under `target/release`. Extract a headless composition factory that accepts those host dependencies. Keep terminal construction in the CLI; add separate desktop construction.

The package also needs a production build. It currently starts through `tsx`, uses TypeScript source imports, and has a `noEmit` configuration. Produce JavaScript and declarations with explicit package exports. Keep Node code, browser-safe contracts, and the terminal entry point separate, and verify that importing the desktop contract cannot pull Ink, filesystem code, or credentials into the renderer.

## Where our interface belongs in Code OSS

Start with a Glyph view in the secondary sidebar, backed by a workbench service that can also drive editor actions and review surfaces. Use Code OSS's DOM controls, theme tokens, focus management, lists, and editor widgets for the first implementation. The terminal's Ink components are presentation-specific and should be replaced. A separate React layer is unnecessary for proving this integration; we can evaluate one later within a native view if product design justifies it.

The following paths are **proposed additions**, rather than files that already exist upstream:

| Proposed location in the editor fork               | Purpose                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `src/vs/platform/glyph/common/`                    | Process protocol, transport channels, serializable contracts         |
| `src/vs/platform/glyph/electron-main/`             | Application-owned utility-process lifecycle and window connections   |
| `src/vs/platform/glyph/node/`                      | Host entry point and integration with the compiled Glyph package     |
| `src/vs/workbench/contrib/glyph/common/`           | Public internal API for Glyph workbench features                     |
| `src/vs/workbench/contrib/glyph/browser/`          | Native views, actions, editor context, review, and workspace adapter |
| `src/vs/workbench/contrib/glyph/electron-browser/` | Desktop transport client and service registration                    |
| `src/vs/workbench/contrib/glyph/test/`             | Browser, service, and desktop integration tests                      |

Register the feature through its `.contribution.ts` entry point and the desktop workbench entry file. Keep a feature-local service in the contribution until other core components genuinely need it; then promote that service deliberately. Respect the dependency direction between `platform`, `editor`, and `workbench`. Node imports must not leak into browser code. [Source layers and entry points](https://github.com/microsoft/vscode/blob/main/.github/instructions/source-code-organization.instructions.md)

For concrete registration examples, inspect the upstream terminal's desktop contribution for service wiring and the workbench editor contribution for native pane and diff-editor registration. These are navigation anchors to check at the selected revision, rather than APIs to copy without inspection. [Terminal contribution](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/electron-browser/terminal.contribution.ts), [editor registration](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/editor/editor.contribution.ts)

A sidebar is only the initial surface. The same built-in service can drive a selection action, a composer anchored inside the editor, a diff editor, line decorations, and Keep/Revert controls. We will include one inline review interaction in the milestone to demonstrate this freedom before investing in a full design system. Changes to the title bar, layout, and editor groups remain available through the fork when the product needs them.

### How to handle upstream chat

Current Code OSS already includes extensive chat UI and an agent host with built-in provider registration. We should inspect these as real reuse opportunities. Adding a Glyph provider directly to that host would also be foundational integration; it would not be an extension. [Provider registration](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/node/agentHostProviderService.ts), [agent provider contract](https://github.com/microsoft/vscode/blob/main/src/vs/platform/agentHost/common/agent.ts)

The default in this plan is a dedicated Glyph host and native Glyph contribution. Our existing session persistence, pending edit queue, approval behavior, and tool-outcome recovery remain authoritative. Adapting all of them into a second session/state system creates translation work and a larger dependency on evolving upstream agent semantics.

Before building a new transport wrapper, make a bounded comparison against the selected revision's agent-host interfaces: can they preserve immediate edits with Keep/Revert review, our account ownership, dirty-buffer operations, approvals, and recovery without replacing domain state? Reuse generic IPC and lifecycle helpers immediately. Adopt the broader host protocol only if that comparison demonstrably reduces code while preserving these behaviors; record the decision in the fork.

Do not start by deleting upstream chat directories. Audit its visible entry points, default agent configuration, onboarding, and actions. Use product configuration and narrow contribution gates to give Glyph a coherent interface while retaining unrelated dependencies. The exact gates require inspection at the pinned revision. [Current product configuration](https://github.com/microsoft/vscode/blob/main/product.json)

## Host ownership and the process contract

Use one Glyph utility host per application user-data instance, with explicit profile namespaces. It owns account refresh and storage once, then creates workspace-scoped runtimes with access to the corresponding editor window. Electron main supervises it; the renderer never runs the model SDK or receives account tokens.

This ownership needs a small refactor, not just a different launcher. [FileOpenAIAccountStore](../src/providers/openai/auth/FileOpenAIAccountStore.ts) takes an exclusive `session.lock`, and each [OpenAIBackend](../src/providers/openai/OpenAIBackend.ts) currently acquires and releases its store. Multiple workspace backends cannot each acquire the same store, nor can one workspace's disposal release resources still in use by another. Introduce an application-owned account service and explicitly borrowed or reference-counted workspace access. Desktop state initially lives under Glyph's own editor profile directories, separate from terminal state.

Keep one live conversation per profile, workspace, account, and chat ID. Serialize send/reset/review-feedback operations through that owner. The current runtime's busy check applies to one object; opening the same persisted chat twice creates two objects and does not provide this guarantee.

For the first milestone, one window owns Glyph mutations for a workspace. Another authorized window in the same profile and workspace can view its transcript and focus the owning window, but cannot start a competing editing session. Overlapping canonical roots also block competing ownership; sharing a root does not grant access to another profile's or workspace's transcript. Ownership transfer requires stopping active work and invalidating old document tokens. Different, non-overlapping projects can operate concurrently. Profile separation must not accidentally permit competing ownership of the same roots within the application.

The protocol should cover these operations without exposing arbitrary method calls:

| Direction                     | Operations                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workbench to host             | Attach workspace, list/create/open chat, select account/model, send, cancel run, answer question, decide approval, keep/revert proposal item, stop shell session, detach |
| Host to workbench             | Initial state, chat updates, response chunks, tool activity, proposal changes, questions, approvals, usage, typed errors, host status                                    |
| Host to owning editor adapter | Read authorized snapshot, search working-copy text, apply guarded mutation, inspect mutation receipt                                                                     |

Every connection negotiates a protocol version. Requests and events carry the relevant profile, window, workspace, chat, run, and request identifiers; events carry monotonically increasing sequence numbers and a host-generation identifier. Derive authority from the connection registered by Electron main, validate supplied identifiers against it, and reject requests for another workspace or account's chat. Pass URI data and plain records, not class instances, callbacks, `Error` objects, or `AbortSignal`. Cancellation becomes an explicit command, translated into an `AbortController` inside the host.

Bound event queues and batch text deltas so a large response cannot monopolize the UI. Reconnect from a snapshot plus sequence watermark; gaps request another snapshot. Deduplicate commands by request ID. Questions and shell approvals expire with their originating run. Applied proposals remain reviewable after that run ends; keep/revert decisions are bound to their proposal, review item, and operation ID. In-flight editor capabilities expire on disconnect or workspace change and require fresh validation. An old reply must never authorize new work.

The existing chat store checkpoints provider/tool state during a turn but saves final transcript text on completion. It is not an event replay log. Add a host-owned run projection with partial text, tool cards, pending questions, and terminal status. Keep it in memory for reconnects and checkpoint enough display state to show an interrupted run after host failure. Provider checkpoints remain the authority for continuation. Never interpret a missing response as permission to repeat a shell command or edit with an unknown outcome.

On renderer reload or loss of the owning connection, cancel the active turn, deny pending approvals, and retain its interrupted state for reconnection. On owner-window close, stop that workspace's shell sessions and release its ownership after cleanup. “Cancel response” during ordinary use cancels the foreground run; an already-backgrounded shell has a separate Stop action. Application quit drains persistence and terminates child processes. A host crash must leave the editor usable and present a recoverable disconnected state.

Host-crash cleanup needs supervision outside the host: the current shell launcher can create detached process groups. Register child ownership with an application-owned supervisor or implement a verified native parent-death mechanism before allowing command execution. Prove that killing the utility host also terminates its commands and native helpers; graceful `dispose()` tests alone cannot establish this.

## Make the editor authoritative for text

The highest-risk bug would be showing the user one file while the agent reads or overwrites another version of it. A filesystem adapter is insufficient once unsaved working copies exist.

### Reads and searches

Resolve workspace roots from the workbench's workspace service, then canonicalize them through Glyph's path policy. Do not use the application process's current directory. Preserve root names, project identity, and mutation scope. Changes to workspace folders invalidate outstanding capabilities and pending edit tokens.

For text reads and explicit context attachments, prefer the owning window's live model and include its source and concurrency token. Resolve unopened files through the workbench's text-file/model services. Selection attachments pin the chosen range and text at send time. Merely opening or switching an editor must not initiate model requests.

The Rust index can continue to discover disk paths. Content search must replace results for dirty resources with searches of their live buffers, including suppressing stale disk matches. Otherwise “search” and “read” disagree. Keep the same exclusions, size limits, and access policy for both. Limit the first milestone to local `file:` resources; reject remote and unsupported virtual schemes explicitly.

### Content hashes and editor versions serve different purposes

[WorkspaceTextSnapshot](../src/workspace/WorkspaceTextSnapshot.ts) currently uses `revision` as a content hash. Proposal construction and crash recovery also compute expected hashes. Replacing that value with a Monaco document version would break those semantics.

Retain content hashes and introduce a separate opaque host token: workspace generation, resource/model incarnation, and document version. Carry it from the read through proposal state into the mutation precondition. A model incarnation distinguishes closing and reopening a document whose version counter starts over. Persist content-based proposal state, but revalidate editor tokens after reconnect or restart; old tokens are not reusable authority.

Preserve the review manager's existing transformation of non-overlapping manual edits. When content changes, a safe transformation can produce a fresh preview, snapshot, and host token. Overlapping changes or a race after that fresh snapshot must refuse application. Test both outcomes; a changed version alone should not remove the existing safe-rebase capability.

Apply text edits through the editor's versioned edit and undo machinery. Upstream `ResourceTextEdit` accepts a `versionId`; the bulk text implementation validates models after asynchronous preparation and applies edits with undo support. Audit that path at the pinned revision, including our model-incarnation guard, rather than doing a version check before an asynchronous RPC. [Bulk edit API](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/services/bulkEditService.ts), [text edit implementation](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/bulkEdit/browser/bulkTextEdits.ts)

Our adapter must prove that its expected version is checked at the actual mutation boundary. If existing primitives leave a gap, add a narrow internal editor transaction method. Do not advertise `ATOMIC_VERSIONED` merely because an earlier check succeeded.

### Application, saving, and recovery

Preview edits with immutable models under a Glyph-owned URI scheme and the native diff editor. Apply text changes immediately through the live buffer and save the edited resource before reporting success. This saves any pre-existing unsaved text in that same file, while preserving it in the edit baseline. Do not save unrelated dirty documents. Skip save participants so formatters do not introduce changes outside the recorded edit. Keep confirms the applied change without rewriting the file. Revert writes a guarded inverse, preserving disjoint later edits and refusing overlaps. Verify saved bytes before starting subsequent commands.

Map each applied hunk and each revert to a durable operation ID and undo group. Keep performs no editor mutation. Bulk revert works backward through the selected changes so later edits are undone before earlier ones. Separate agent edits interleaved with manual typing must not merge into one surprising undo operation.

Keep durable operation IDs and application receipts so a lost acknowledgement cannot apply the same edit twice. Recovery must distinguish “applied to a working copy,” “saved,” “subsequently undone,” and “outcome uncertain.” A content comparison alone cannot establish user intent after undo or a crash. Reconcile against restored working copies before marking an in-flight application complete.

Text changes, create, rename, and delete apply immediately and remain reviewable. Structural operations use their own workbench file-operation integration, dirty-file handling, and recovery checks. `ResourceFileEdit` does not carry the same text-model version precondition. Audit these operations separately and refine the currently store-wide mutation-consistency contract if guarantees differ by operation. Keep unsupported operations disabled in both the UI and model-facing tool schema until their adapter is verified. Never claim multi-file application or revert is a filesystem transaction; retain per-item outcomes when a batch partially succeeds.

Preserve UTF-8/BOM, normal LF/CRLF, final-newline behavior, and file modes where supported. Mixed line endings and other encodings need explicit losslessness checks because editor models may normalize representation. Initially make unsupported documents ineligible for mutation instead of silently changing their encoding or bytes.

Review decisions can arrive while a response streams. The current runtime forbids `recordContext` while busy, so queue decision feedback for a safe boundary and retain its original chat/account ownership. Add proposal-change events to update the sidebar and inline UI from the same host state. Do not have each view poll or mutate review objects independently.

## Shell execution and native interactions

Reuse Glyph's authorizer, permission store, sandbox launcher, and shell session manager. Render approvals as native workbench controls that preserve their existing scopes and distinguish sandboxed execution from explicit execution outside the sandbox. Bind decisions to the exact pending request. Question forms use the existing presenter boundary in the same way.

Display command output in a Glyph tool/output surface first. An ordinary integrated terminal is useful editor infrastructure, but executing agent commands through it would skip our launcher and its guarantees. A later terminal presentation adapter must still be driven by Glyph-owned processes.

Shell programs see saved files. Successful agent edits save the changed resource before returning, so the agent can build, test, run a server, and iterate without waiting for Keep. Unrelated unsaved buffers remain unsaved and are not visible to shell programs. Save failure is a tool failure even if the buffer edit already happened; inspect the current state before retrying. Revalidate inverse edits against current content when reverting after commands change disk content. If the user types while a command runs, preserve that new buffer through normal workbench disk-conflict handling; never force a reload over it.

Connect workbench trust to agent capabilities: an untrusted workspace cannot automatically enable agent tools or transmit workspace context. Preserve the existing canonical path, symlink, exclusion, and protected-runtime policies in every new adapter. Render model text as untrusted Markdown; model-generated command links or HTML cannot dispatch privileged workbench operations.

OAuth remains behind the existing account service. The desktop presenter opens the authorization URL through the workbench's external opener; callbacks and token handling stay in the host. Validate callback and logout behavior in the packaged application. Review OS-backed credential storage as part of desktop hardening without sending tokens through renderer events or logs.

## Repository and build arrangement

Keep this repository as the source of the harness and terminal application. Create a separate editor fork with normal upstream history and an `upstream` remote. Keep its repository layout and build tooling intact; do not turn the Code OSS root into our pnpm workspace.

The fork consumes a pinned build artifact from Glyph. Start with a locally built package/archive containing emitted code, declarations, dependency metadata, and a manifest identifying the Glyph commit and protocol version. A development script can rebuild and install that artifact. CI must reproduce it from a recorded commit and verify its checksum. Neither development nor release should depend on accidental imports into a sibling checkout, and publishing a public npm package is unnecessary.

Keep browser-safe protocol exports separate from the Node host package. Place the packaged host, native dependencies, and helpers in explicit application resources; register the host entry point with the selected upstream build. Its resource resolver must work in both development and packaged applications.

Use the upstream revision's `.nvmrc`, `.npmrc`, lockfiles, and platform prerequisites. The documented development loop is `npm install`, `npm run watch`, and `./scripts/code.sh`, with targeted tests through `./scripts/test.sh`. Confirm the commands against the selected tag. Keep Glyph's pnpm/Rust checks in its own checkout. [Contributor guide](https://github.com/microsoft/vscode/wiki/How-to-Contribute), [Node pin](https://github.com/microsoft/vscode/blob/main/.nvmrc), [native build configuration](https://github.com/microsoft/vscode/blob/main/.npmrc)

Test native packaging early. `better-sqlite3` must match the Electron host's Node ABI; a binary installed for the terminal's Node runtime is not sufficient evidence. The Rust index and sandbox need the correct architecture, executable permissions, protected paths, and locations outside archives that cannot execute them. Signing must eventually cover the helpers too. [Packaging tasks](https://github.com/microsoft/vscode/blob/main/build/gulpfile.vscode.ts), [macOS signing implementation](https://github.com/microsoft/vscode/blob/main/build/darwin/sign.ts)

Start with the developer's native macOS architecture and local workspaces. Linux and Windows builds, remote execution, notebooks, virtual filesystems, and browser deployment are separate follow-ups. Windows shell support in particular needs additional work in the current harness. Unsupported capabilities should be visible and fail closed.

## Implementation sequence and demonstrations

Each phase produces something we can inspect together. Use a deterministic fake provider for automated tests; add a manual real-account smoke test after the transport works.

| Phase                                                   | Implementation work                                                                                                                                       | Demonstration and exit condition                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Establish the editor fork                            | Pin an upstream release/SHA; build unchanged; add Glyph identity and isolated profile paths; inventory upstream chat integration points                   | Launch our own editor, edit/debug normally, and record exact build commands and baseline startup behavior                                                                          |
| 1. Prove native runtime packaging                       | Extract host composition and compiled exports; boot a minimal utility host; package SQLite and Rust helpers; perform the bounded upstream-host comparison | From a packaged `.app`, open a temporary database, start the index, and exercise the sandbox with the source checkout unavailable                                                  |
| 2. Build native interaction with a fake host            | Add the Glyph contribution, service, process protocol, composer, transcript, cancellation, selection action, and inline proposal affordance               | Fake streaming, question/approval controls, and an inline review render correctly with keyboard navigation, theme changes, and no extension activation                             |
| 3. Connect real chat and editor context                 | Add app-owned accounts, workspace runtimes, session ownership, real streams, dirty-buffer reads, and search overlay                                       | Sign in, resume a chat, ask about an unsaved selection, and verify the exact text received by the provider; a second window cannot create a competing owner                        |
| 4. Prove safe native editing                            | Add separate host tokens, versioned text application, immutable diff previews, receipts, saving, and undo grouping for text and structural changes        | Apply and save before review; keep/revert; preserve non-overlapping typing; refuse conflicting reverts and mutation races; undo/redo; preserve user edits and tested file metadata |
| 5. Exercise tools and recovery                          | Wire sandbox approvals and question forms; define dirty-file shell handling; add run snapshots, host restart, and external child-process supervision      | Cancel while awaiting approval; reload mid-stream; simulate lost mutation acknowledgements; kill the host without leaving orphan commands; recover without repeating side effects  |
| 6. Validate the integrated product and maintenance cost | Run the whole workflow in a packaged app; test essential extensions; rehearse an upstream update; document the development loop                           | Complete the milestone script below, retain evidence, and record the actual upstream conflicts before expanding UI scope                                                           |

Phases 1 and 2 can proceed in parallel after the protocol contract is agreed. The workbench adapter and host ownership are prerequisites for real editing. Broad visual redesign should follow Phase 4, when the underlying interaction is trustworthy. Native packaging failures in Phase 1 are a reason to adjust the host/build design immediately.

Suggested implementation ownership for parallel agents:

- **Harness owner:** headless composition, package exports, shared account ownership, session serialization, protocol types, persistence and review notifications in this repository.
- **Workbench owner:** native views/actions, UI state projection, editor adapter, diff/undo behavior, and workbench tests in the fork.
- **Desktop integration owner:** utility-process lifecycle, transport, product configuration, native resources, packaging, and upgrade checks in the fork.

Agree on protocol and mutation contracts first. Assign one owner to registration files, manifests, and lockfiles so parallel changes remain reviewable.

The milestone review is a concrete script:

1. Launch the packaged Glyph editor and open a local test project.
2. Modify a UTF-8 source file without saving; select a function and ask for a change.
3. Verify the agent sees unsaved text, applies its edit, and saves the edited file before review. Verify a command sees the new bytes while unrelated dirty files stay unsaved.
4. Open a native diff and keep one applied change without a second write. Revert another change, then verify editor Undo/Redo without losing earlier manual edits.
5. Verify unrelated typing survives a revert. Introduce an overlapping newer edit and verify reverting the earlier edit refuses it. Verify bulk revert unwinds newer edits first, including content edits followed by a rename reversal. Exercise create/delete review and mutation-time version races.
6. Exercise an approval and question, cancel another turn, and verify late replies cannot restart work.
7. Reload during streaming and simulate host failure after an edit request. Restore useful state without silently repeating a write or command.
8. Open the project in another window and verify ownership behavior. Open a different project and verify isolation.
9. Close the owning window and verify background processes and account/store ownership clean up correctly.
10. Repeat the essential workflow after an upstream update rehearsal.

Passing this means we can build the proper UI on a proven integration. It does not require completing every feature of the terminal UI or matching Cursor's full product scope.

## Distribution and ongoing maintenance

Code OSS's source is MIT-licensed; Microsoft's branded VS Code distribution and service access have additional terms. Preserve required notices and supply our own application identity, icons, bundle identifier, protocol, data directories, and service configuration. Microsoft's FAQ explicitly says alternative Code OSS products may not access Visual Studio Marketplace. Use Open VSX or independently distributed extensions with suitable licenses instead. [Repository license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt), [Microsoft FAQ](https://code.visualstudio.com/docs/supporting/faq), [Open VSX configuration](https://github.com/eclipse-openvsx/openvsx/wiki/Using-Open-VSX-in-VS-Code)

Preserving the extension host gives us the compatibility machinery, but not a guarantee that every extension is available, licensed for the fork, or compatible with its proposed APIs and native dependencies. During the milestone, test a short list of essential language, debugging, source-control, and theme extensions. Record missing capabilities and alternatives; do not equate a successful gallery search with compatibility.

Similarly, upstream remote infrastructure does not grant redistribution rights to Microsoft's Remote-SSH, WSL, Dev Containers extensions, or its distributed VS Code Server. A remote phase must choose distributable components and run Glyph's filesystem tools and shell on the machine that owns the workspace. A remote URI cannot be treated as a local pathname. [Remote development FAQ](https://code.visualstudio.com/docs/remote/faq), [extension licensing information](https://code.visualstudio.com/docs/supporting/oss-extensions)

Before public distribution, finish signing/notarization, clean-machine installation, third-party notices, update delivery, credential storage, and deliberate telemetry/crash-reporting policy. Audit product-specific endpoints and built-in dependencies rather than inheriting Microsoft services by assumption. These are release tasks; local packaging belongs much earlier. [Differences between Code OSS and Microsoft's distribution](https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code)

Maintain a short inventory of every changed upstream file and why it is necessary. Keep most code in Glyph-owned directories and isolate patches for entry points, process startup, build resources, and product configuration. Integrate released upstream updates on a regular cadence, with prompt security updates. Each update runs harness contracts, workbench adapter tests, and the packaged milestone smoke test. The upgrade rehearsal is how we measure whether the patch surface is actually manageable.

The first implementation task is therefore a small pair of deliverables: a reproducible Code OSS fork baseline, and a compiled Glyph host that loads its native dependencies inside the packaged editor. Once those work, the next task is native chat plus a dirty-buffer edit and undo workflow. That order answers the architectural questions before we commit to a large interface build.
