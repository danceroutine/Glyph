import { test as it } from './GlyphWorkbench.fixture.mjs';

// Pending black-box contracts: these scenarios still need production UI wiring.
// Enable these with scripted provider tool calls through the production runtime,
// observable workbench results, and disposable workspace/process fixtures.
// Existing runtime unit tests do not establish desktop end-to-end coverage.

it.describe('Pending Shell Execute (execute_shell)', () => {
  it.fixme(
    'runs an approved command in the requested workspace directory and shows its output and exit status',
    async () => {},
  );
  it.fixme('keeps a command from running while approval is pending or after the user denies it', async () => {});
  it.fixme('shows a nonzero exit as a failed command and lets the agent explain the returned error', async () => {});
  it.fixme('stops a timed-out or cancelled foreground command and restores an interactive composer', async () => {});
});

it.describe('Pending Shell Write Input (write_shell_input)', () => {
  it.fixme('delivers input to the selected running shell and shows the resulting interactive output', async () => {});
  it.fixme('respects append_newline so typing input and submitting it remain distinct operations', async () => {});
  it.fixme('reports an unknown or idle shell without starting a command or bypassing command approval', async () => {});
  it.fixme('refuses to write input to a shell owned by another chat', async () => {});
});

it.describe('Pending Shell Close (close_shell)', () => {
  it.fixme(
    'terminates the selected shell process and its children and removes it from the live shell list',
    async () => {},
  );
  it.fixme('reports an already closed or unknown shell without affecting another running shell', async () => {});
  it.fixme('refuses to close a shell owned by another chat', async () => {});
});

it.describe('Pending Shell List (list_shells)', () => {
  it.fixme(
    'shows each shell owned by the current chat with its command, directory, status, and bounded recent output',
    async () => {},
  );
  it.fixme('reports an empty shell list without inventing a session or showing another chat’s shells', async () => {});
  it.fixme('reflects command completion and removes closed shells when the agent lists shells again', async () => {});
});

it.describe('Pending Propose Patch (propose_patch)', () => {
  it.fixme(
    'renders a strict patch as reviewable file changes and leaves editor buffers and disk unchanged before acceptance',
    async () => {},
  );
  it.fixme(
    'applies only accepted patch items to the live editor and reports accepted and rejected items to the agent',
    async () => {},
  );
  it.fixme('rejects malformed patches and stale revisions without partially applying their changes', async () => {});
});

it.describe('Pending Propose Edits (propose_edits)', () => {
  it.fixme(
    'applies explicit LF/CRLF conversions through an undoable editor EOL operation before accepting the proposal',
    async () => {},
  );
  it.fixme(
    'renders structured range edits at the intended locations while preserving Unicode, whitespace, and line endings',
    async () => {},
  );
  it.fixme(
    'applies accepted edits as an undoable editor operation and leaves rejected edits unapplied',
    async () => {},
  );
  it.fixme(
    'refuses invalid ranges or edits based on an older editor version without modifying the document',
    async () => {},
  );
});

// Create/delete are staged file operations in patch/structured-edit proposals,
// not separate registered project tool names. Desktop application is still pending.
it.describe('Pending structural file mutations through a reviewed proposal', () => {
  it.fixme(
    'shows a proposed rename and moves the file through the workbench only after acceptance, with Undo restoring its original path',
    async () => {},
  );
  it.fixme(
    'preserves both files when a rename is rejected or its destination becomes occupied before acceptance',
    async () => {},
  );
});

it.describe('Pending Delete File through a reviewed proposal', () => {
  it.fixme(
    'shows the file and its contents in a deletion review without deleting it before acceptance',
    async () => {},
  );
  it.fixme('deletes an accepted file through the workbench and lets Undo restore its contents', async () => {});
  it.fixme('preserves the file after rejection and refuses a stale deletion after the user edits it', async () => {});
  it.fixme('refuses deletion outside the authorized workspace without affecting the target file', async () => {});
});

it.describe('Pending Create File through a reviewed proposal', () => {
  it.fixme('shows the proposed path and contents without creating the file before acceptance', async () => {});
  it.fixme('creates an accepted file with the proposed contents and lets Undo reverse its creation', async () => {});
  it.fixme(
    'leaves no file after rejection and refuses to overwrite a file created while the proposal was pending',
    async () => {},
  );
  it.fixme(
    'refuses creation outside the authorized workspace without leaving files or directories behind',
    async () => {},
  );
});
