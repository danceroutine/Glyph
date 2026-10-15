import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending context assembly contracts. Use distinctive file contents, dirty
// buffers, and recorded provider inputs to verify what was actually sent.
// Retrieval cases need deterministic local ranking/embedding fixtures; assertions
// must cover provenance and omitted data, not just a plausible generated answer.

it.describe('Pending active editor and open-file context', () => {
  it.fixme(
    'reattaches the host and editor to changed workspace folders without a reload and never reinterprets old paths or document tokens under the new roots',
    async () => {},
  );
  it.fixme(
    'shows the active file’s workspace-qualified path and lets the user include or exclude it from the next turn',
    async () => {},
  );
  it.fixme(
    'captures unsaved active-editor contents with their revision rather than silently substituting the file on disk',
    async () => {},
  );
  it.fixme(
    'updates automatic context when the user switches editor tabs while keeping explicitly pinned attachments intact',
    async () => {},
  );
  it.fixme(
    'identifies the focused editor in a split layout instead of taking context from a different visible editor',
    async () => {},
  );
  it.fixme('lets the user choose other open files without automatically sending every tab’s contents', async () => {});
  it.fixme(
    'handles an empty editor, untitled buffer, unsupported resource, or deleted file with an explicit context state',
    async () => {},
  );
  it.fixme(
    'distinguishes same-named files across workspace roots in the context picker and outgoing attachments',
    async () => {},
  );
  it.fixme(
    'identifies the selected side of a diff editor so original and modified text are not confused',
    async () => {},
  );
});

it.describe('Pending editor selections sent to chat', () => {
  it.fixme(
    'offers an editor action and keyboard shortcut to attach highlighted code without submitting the chat draft',
    async () => {},
  );
  it.fixme(
    'shows a selection pill with filename and range and lets the user preview its exact captured text',
    async () => {},
  );
  it.fixme('preserves whitespace, Unicode, and line breaks in a highlighted passage sent to the agent', async () => {});
  it.fixme(
    'attaches multiple noncontiguous selections with separate source ranges instead of merging unrelated text',
    async () => {},
  );
  it.fixme(
    'lets the user add selections from multiple files and remove one attachment without losing the others or the draft',
    async () => {},
  );
  it.fixme(
    'opens the attachment’s source location when its pill is clicked and reports a stale or deleted source explicitly',
    async () => {},
  );
  it.fixme(
    'keeps a captured selection stable after cursor movement and offers an explicit refresh after the source text changes',
    async () => {},
  );
  it.fixme('sends only the selected passage unless the user also authorizes full-file context', async () => {});
  it.fixme(
    'records the exact source revision and text sent with a turn so later edits cannot rewrite its attachment history',
    async () => {},
  );
  it.fixme(
    'preserves selection attachments while a message is queued or edited and does not silently replace them at delivery time',
    async () => {},
  );
});

it.describe('Pending IDE diagnostic, symbol, and change context', () => {
  it.fixme(
    'lets the user attach a diagnostic with its file, range, message, and current editor revision',
    async () => {},
  );
  it.fixme(
    'finds related definitions, references, and imports for selected code with navigable source provenance',
    async () => {},
  );
  it.fixme(
    'uses refreshed language-server information after edits and marks unavailable or stale symbol results',
    async () => {},
  );
  it.fixme(
    'lets the user attach staged or unstaged changes with an explicit diff base instead of silently reading unrelated repository history',
    async () => {},
  );
  it.fixme(
    'lets the user attach selected terminal or test output and identifies its originating command or test run',
    async () => {},
  );
  it.fixme(
    'shows missing language-server or repository support and falls back to available file context without inventing diagnostics',
    async () => {},
  );
});

it.describe('Pending intelligent context discovery and RAG', () => {
  it.fixme(
    'finds relevant project passages for a natural-language question even when the wording differs from the source text',
    async () => {},
  );
  it.fixme(
    'combines lexical, semantic, and symbol-based discovery while retaining each result’s path, range, revision, and retrieval reason',
    async () => {},
  );
  it.fixme(
    'ranks relevant source passages above unrelated files in a deterministic fixture and deduplicates overlapping chunks',
    async () => {},
  );
  it.fixme(
    'expands a retrieved passage to its enclosing symbol or relevant dependencies within the configured context budget',
    async () => {},
  );
  // Lexical search's rank-7 contract is covered in GlyphProjectTools.test.mjs.
  // This remaining contract requires the future semantic/symbol retrieval path.
  it.fixme(
    'prefers current unsaved editor text over stale semantic and symbol retrieval passages and removes obsolete chunks from that file',
    async () => {},
  );
  it.fixme(
    'updates discovery after file creation, edits, renames, deletion, branch changes, or workspace-folder changes',
    async () => {},
  );
  it.fixme(
    'shows indexing progress, partial coverage, and index failures without blocking explicit file attachments',
    async () => {},
  );
  it.fixme(
    'falls back to lexical or direct file discovery when semantic indexing is unavailable and labels the fallback',
    async () => {},
  );
  it.fixme('lets the user inspect, include, pin, or exclude retrieved passages before they are sent', async () => {});
  it.fixme(
    'reports that no relevant context was found rather than adding unrelated passages to fill the budget',
    async () => {},
  );
  it.fixme(
    'rebuilds an incompatible or corrupted index and does not mix results from different projects or index versions',
    async () => {},
  );
});

it.describe('Pending IDE context budgets and privacy', () => {
  it.fixme(
    'lets the user configure sensitive-file exclusions in settings and consistently applies them to file reads, attachments, indexing, and retrieval',
    async () => {},
  );
  it.fixme(
    'shows the assembled context sources and estimated budget use and identifies what was omitted or truncated',
    async () => {},
  );
  it.fixme(
    'keeps explicitly selected context distinguishable from automatically retrieved context when applying budget limits',
    async () => {},
  );
  it.fixme(
    'asks the user to reduce oversized explicit attachments instead of silently dropping selected passages',
    async () => {},
  );
  it.fixme(
    'excludes sensitive, ignored, and user-denied paths from indexing and retrieval and enforces workspace symlink boundaries',
    async () => {},
  );
  it.fixme(
    'blocks automatic project indexing and context transmission in an untrusted workspace until the user grants trust',
    async () => {},
  );
  it.fixme(
    'requires explicit consent before transmitting source text to a remote embedding or retrieval service',
    async () => {},
  );
  it.fixme(
    'lets the user disable automatic retrieval and clear the workspace index without deleting project files',
    async () => {},
  );
  it.fixme(
    'keeps cached contexts and indexes isolated between workspaces, profiles, and chats with different authorization',
    async () => {},
  );
  it.fixme(
    'cancels pending retrieval when its turn is cancelled and prevents late context from entering a different turn',
    async () => {},
  );
  it.fixme(
    'treats retrieved file contents as task data and loads instructions only through the authorized rules and AGENTS.md paths',
    async () => {},
  );
});
