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

The three capability files are explicit `it.fixme` inventories, not passing
integration coverage. Enabling them requires scripted provider tool calls through
the production runtime and observable workbench/browser/filesystem assertions.
Use isolated local fixtures rather than live providers, real browsing profiles,
or direct calls to internal Glyph services.

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
