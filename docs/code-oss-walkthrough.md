# Glyph Code OSS implementation walkthrough

Current editing behavior: proposals apply and save their changes immediately. Keep confirms an applied change; Revert performs a guarded inverse. The checkpoint notes below record the earlier walkthrough and its findings at that time. The current contract is described in [Application, saving, and recovery](code-oss-integration-plan.md#application-saving-and-recovery).

The reader helped design Glyph and understands hexagonal architecture, ports,
adapters, and the intended product. The learning target is VS Code internals:
how our implementations register with, call into, and run inside Code OSS.
Explain unfamiliar upstream machinery at its first use in actual code.

Follow workbench registration, user action, process transport, host dispatch,
and the return trip into a live editor model. The architecture plan is a
reference, not the syllabus. The original buckets remain a change inventory;
this learning sequence crosses them where a call chain requires it.

## Pacing and resumption

- Present one checkpoint per turn, then stop. Clarifying questions do not imply
  permission to advance. Combine checkpoints only when requested.
- Use small code excerpts and clickable locations. Explain the VS Code API,
  then what our implementation does with it. Skip general architecture recaps.
- Inspect upstream definitions for precision without narrating every file.
- Leave a presented checkpoint unchecked until the user is ready to move on.
  Record questions and decisions here, then update the resume position.
- Distinguish connected code, implemented but unwired adapters, and future work.
  A type declaration or method name does not prove runtime behavior.
- Recheck relevant source on resumption; do not repeat completed explanations.

## Current position

- Earlier architecture-level introduction superseded by the user's clarification.
- Active checkpoint: 11, build and packaging, presented for discussion.
- Completed implementation checkpoints: 1, registration; 2, injection/lifecycle;
  3, native pane rendering; 4, selection action; 5, renderer transport;
  6, utility-host startup; 7, host request dispatch; 8, editor-backed reads;
  9, native edits and undo, including gestalt clarification; 10, real-service composition.
- Next: discuss the final build checkpoint and remaining gaps; no automatic next topic.

## Implementation checkpoints

- [x] **1. How Code OSS discovers and places Glyph's UI.**
      Read the workbench import in `scripts/code-oss/apply-overlay.mjs` and
      `glyph.contribution.ts` through `registerViews`. Explain module side effects,
      `Registry.as`, view container versus view, `AuxiliaryBar`, and `SyncDescriptor`.
      Locate `registerSingleton` but defer its mechanics and the action block. Pause.

- [x] **2. How VS Code constructs and injects our service.**
      Read `common/glyph.ts`, singleton registration, and constructors in
      `GlyphWorkbenchService` and `GlyphViewPane`. Explain `createDecorator`, the
      shared interface/value name, parameter decorators, `IInstantiationService`,
      delayed instantiation, and scope. Explain `Disposable`, `_register`, `Emitter`,
      and `Event` as used here. Pause before rendering and transport.

- [x] **3. How a native pane renders and updates.**
      Read `GlyphViewPane` constructor, `renderBody`, `renderState`, and `submit`.
      Explain `ViewPane` lifecycle, DOM helpers, theme variables, and subscriptions.
      Trace one button click and one state update. Pause at the service boundary.

- [x] **4. How an editor action captures a selection.**
      Read `ExplainSelectionWithGlyph` and `GlyphWorkbenchService.send`.
      Explain `Action2`, `registerAction2`, `f1`, `ServicesAccessor`,
      `ICodeEditorService`, editor widget versus model, URI, workspace lookup,
      and `IViewsService.openView`. Follow selection into an attachment. Pause.

- [x] **5. How the renderer obtains a connection and sends commands.**
      Read `GlyphDesktopClient.connectNow`, `request`, and `receive`, plus the
      matching `GlyphHostStarter.connectWindow`. Explain `acquirePort`, IPC channel
      names, port transfer, handshake, pending promises, and identity. Pause before
      the utility-process startup details.

- [x] **6. How Electron main starts the Glyph host.**
      Read application registration in the overlay script, `GlyphHostStarter.start`,
      `glyphHostBootstrap`, and `utilityMain`. Explain application DI scope,
      `UtilityProcess`, upstream entry-point loading, artifact resolution,
      `process.parentPort`, and port hookup. Trace actual exit/disposal behavior. Pause.

- [x] **7. What happens to a request inside the host.**
      Follow `GlyphDesktopHost.receive` through validation, attach, dispatch, and
      events. Explain the ownership, deduplication, and journaling collaborators in
      that path. Show the factory selecting `DeterministicDesktopRuntime` and the
      real composition gap. Pause before editor operations.

- [x] **8. How the workspace port reads a VS Code model.**
      Connect `EditorWorkspaceTextStore.read`, `EditorWorkspaceClient`, and
      `GlyphEditorAdapter.read`/`snapshot`/`resolve`. Explain
      `ITextModelService.createModelReference`, reference lifetime, `ITextModel`,
      URI resolution, hashes, and version/incarnation tokens. Show the missing
      transport wiring between adapter halves explicitly. Pause before mutations.

- [x] **9. How applied edits use native edit and undo services.**
      Follow store `replace`, adapter `apply`, `ResourceTextEdit`, `IBulkEditService`,
      `UndoRedoGroup`, and proposal mutation metadata. Inspect upstream for exact
      version checks, async boundaries, receipts, undo, and save behavior.
      Separate implemented guarantees from missing integration. Pause.

- [x] **10. How the real Glyph services fit into the host.**
      Read `OpenAIAccountService`, session reuse/queues, and proposal notifications.
      Focus on desktop composition and resource lifetime. Locate presenter ports
      that still lack connected desktop implementations. Skip the engine recap. Pause.

- [ ] **11. How the pieces become a runnable fork.**
      Read upstream pin, bootstrap/overlay/runner, build config, artifact script,
      and package exports. Explain checked-in overlay versus generated source,
      browser/Node boundaries, native dependencies, and launch paths. Reconcile
      documentation with actual functionality and record unreviewed changes. Pause.

## Discussion record

- User correction: architecture and ports/adapters are familiar. Focus on their
  implementations and VS Code internals, teaching APIs through actual call sites.
- Checkpoint 1: entry import executes registration; container supplies the shell,
  view supplies Glyph content; descriptors leave construction to VS Code.
  User confirmed understanding and requested the next checkpoint.
- Checkpoint 2: service identifier versus interface; decorators record parameter
  dependencies; instantiation resolves them from the window's service collection.
  Delayed services use a proxy and idle initialization. `Disposable` owns cleanup;
  events expose subscription while keeping emission private. User confirmed
  understanding and requested the next checkpoint.
- Checkpoint 3: `renderBody` builds the pane's DOM; `renderState` redraws the
  transcript from service state. VS Code supplies pane lifecycle and theme CSS
  variables. Submit/cancel call the service; response events cause redraws.
  Current renderer rebuilds all transcript rows and always scrolls to the bottom.
  User confirmed understanding and requested the next checkpoint.
- Checkpoint 4: `registerAction2` registers command metadata and its handler;
  `f1` exposes it in the Command Palette. `ServicesAccessor` resolves services
  inside `run`. The editor widget supplies the selection; its text model supplies
  live text, URI, and version. Workspace lookup supplies a relative path, and
  `openView(id, true)` reveals/focuses the pane. Selection becomes a serialized
  context attachment. Current capture omits the range and uses placeholder
  generation/incarnation metadata, not the editor mutation adapter's token.
  User requested the next checkpoint.
- Checkpoint 5: `acquirePort` uses renderer IPC and preload forwarding to obtain
  a transferred MessagePort. Main resolves the sender's window and derives its
  identity, then gives the renderer one endpoint of a utility-process channel.
  Client waits for ready, attaches the workspace, and matches request IDs to
  pending promises. Response events separately update the workbench service.
  Discussed current disposal and the absence of automatic reconnect in this
  renderer client. User requested the next checkpoint.
- Checkpoint 6: main application constructs and owns `GlyphHostStarter`, which
  launches lazily on connection. Upstream `UtilityProcess` forks Electron's
  utility process through `bootstrap-fork.js`, which imports our Code OSS
  bootstrap. That shim imports the compiled Glyph artifact from an environment
  path. `utilityMain` receives transferred connection ports via `parentPort`,
  wires them to the host, and sends ready. Explained shared host scope, configured
  dev/built artifact paths, exit handling, and the distinction between launch
  success and Glyph readiness. User requested the next checkpoint.
- Checkpoint 7: host separates active transport connections, retained window
  sessions, and profile/workspace runtimes. Traced request cache, identity/version
  checks, workspace ownership, factory creation, initial state, and send dispatch.
  Runtime events broadcast through per-connection in-memory journals; command
  completion returns separately after `handle` resolves. Fixture cancellation
  uses a separate command; the created AbortController is not wired to cancel.
  `ChatOperationSerializer` is not called by this host. User requested the next checkpoint.
- Checkpoint 8: host-side `EditorWorkspaceTextStore` requests snapshots through
  `EditorWorkspaceClient`; renderer-side `GlyphEditorAdapter` resolves URI-based
  models with `ITextModelService`. Reference disposal releases the adapter's
  ownership, not an unconditional model disposal. Snapshot translates live text
  and model metadata; host validates hash and retains the token privately.
  The transport connecting these halves is absent. Current renderer assumes the
  first local folder, hardcodes mode/dirty metadata, and reads version after an
  asynchronous hash. Revisit that race at the mutation checkpoint. User requested
  the next checkpoint.
- Checkpoint 9: traced proposal operation ID, store replacement/token lookup,
  renderer guards, and `ResourceTextEdit` through `IBulkEditService`. Pinned
  upstream revalidates versions after async preparation and applies a single
  model edit synchronously with an undo stack element. Adapter snapshot/version
  sampling still has races before that boundary. Renderer ignores the supplied
  string undoGroupId; its newly allocated numeric ID is not an active upstream
  bulk-edit group, so upstream allocates its own. Receipts remain in memory.
  User confirmed the gestalt clarification and requested the next checkpoint.
- Gestalt clarification: DI resolves local services, separately from IPC.
  Workbench service maintains renderer UI state; the selection action is a user
  command, not a model tool. Workspace text includes unsaved buffers; the client
  is an interface, and the renderer adapter implements both reads and mutations.
- Checkpoint 10: account service owns the credential-store lifetime and lends
  non-owning store views to backends. Session manager caches one live session per
  chat within that manager, with authorization before cache reuse. Session queues
  serialize send/reset/context. Proposal notifications are plain callbacks,
  requiring conversion to protocol events. Real runtime composition, presenter
  RPC, and renderer question/approval/review controls remain unwired.
  Clarified authorization as local provider/account ownership comparison before
  cached session reuse, not OAuth or credential refresh. User confirmed and advanced.
- Checkpoint 11: separate Code OSS and Glyph builds meet at the utility bootstrap.
  Explained upstream archive pin/checksum/marker, overlay copying and entry-point
  patches, generated versus maintained source, pinned Node runner, tsc relative
  import rewriting, production dependency/native-helper staging, manifests, and
  archive output. Development loads the unpacked staging directory. Current scripts
  do not install that artifact into a distributable editor app. No build or launch
  was executed during this walkthrough. Awaiting final checkpoint discussion.

## Remaining gaps and documentation discrepancies

- Plan's separate-repository instruction is outdated relative to the implemented
  in-repository overlay. Explained in checkpoint 11; source document not edited.
- README inventory overstates the current review UI: inspected native pane has
  transcript, composer, selection context, and send/cancel, without review controls.
- Launch currently uses a deterministic runtime. The editor adapter and real
  provider composition are not fully connected to that path.
- Historical plan statements about missing build/session ownership work differ
  from current uncommitted implementations.
- Host artifact creation and development launch are implemented separately;
  assembly of a distributable editor with the artifact at its built-app path is
  not implemented in the inspected integration scripts.
- Adapter version-snapshot race, undo-group translation, and durable receipts
  require follow-up. Renderer reconnect/replay and real runtime/presenters remain
  unwired. Walkthrough inspection is not runtime validation or a full code review.
