import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending context assembly contracts. Use distinctive file contents, dirty
// buffers, and recorded provider inputs to verify what was actually sent.
// Retrieval cases need deterministic local ranking/embedding fixtures; assertions
// must cover provenance and omitted data, not just a plausible generated answer.

// Rank 10 editor/file capture contracts are exercised through the real native
// editor, inline composer, recorded provider input, and saved chat history in
// GlyphAttachments.test.mjs. The remaining lifecycle dependencies stay explicit.
it.describe('Pending context lifecycle contracts', () => {
  it.fixme(
    'reattaches the host and editor to changed workspace folders without a reload and never reinterprets old paths or document tokens under the new roots',
    async () => {},
  );
  // Editable drafts and failed-send recovery are covered by GlyphAttachments;
  // actual queued delivery belongs to the rank-19 queue/steering work.
  it.fixme(
    'preserves captured selection attachments while a message is queued and does not silently replace them at delivery time',
    async () => {},
  );
});

// Group 13 diagnostic, symbol, Git diff, and terminal/test output contracts are
// exercised through native workbench services, recorded provider input, and
// persisted captures in GlyphIdeCaptures.test.mjs.

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
