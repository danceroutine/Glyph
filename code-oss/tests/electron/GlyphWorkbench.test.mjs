import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.describe('Glyph in the native Code OSS workbench', () => {
  it('opens the Glyph sidebar from the command palette with an accessible message composer', async ({ glyph }) => {
    await expect(glyph.composer).toHaveAttribute('placeholder', 'Ask Glyph about this project');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.page.locator('.glyph-context-chip')).toHaveText('No editor selection attached');
  });

  it('sends a message to the packaged utility host and renders its complete response exactly once', async ({
    glyph,
  }) => {
    await glyph.send('Explain this project.');
    await glyph.waitForResponse();
    await expect(glyph.userEntries).toHaveCount(1);
    await expect(glyph.userEntries.first()).toContainText('Explain this project.');
    await expect(glyph.assistantEntries).toHaveCount(1);
    await expect(glyph.diagnostics).toHaveCount(0);
    await expect(glyph.composer).toHaveValue('');
  });

  it('shows a partial answer while the host is still streaming and restores Send when it finishes', async ({
    glyph,
  }) => {
    await glyph.send('Stream the answer.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    await expect(glyph.assistantEntries.first()).not.toContainText('transport.');
    await glyph.waitForResponse();
  });

  it('preserves a draft and composer focus through streaming updates and ignores submit until the current answer finishes', async ({
    glyph,
  }) => {
    await glyph.send('Stream while I write the next question.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    await glyph.composer.fill('Keep this next question as a draft.');
    await glyph.composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(glyph.composer).toHaveValue('Keep this next question as a draft.');
    await glyph.waitForResponse();
    await expect(glyph.composer).toHaveValue('Keep this next question as a draft.');
    await expect(glyph.composer).toBeFocused();
    await expect(glyph.userEntries).toHaveCount(1);
    await glyph.sendButton.click();
    await glyph.waitForResponse(1);
    await expect(glyph.userEntries.last()).toContainText('Keep this next question as a draft.');
  });

  it('updates an existing assistant row during streaming instead of replacing its DOM node', async ({ glyph }) => {
    await glyph.send('Keep the same response element.');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    const row = await glyph.assistantEntries.first().elementHandle();
    if (!row) throw new Error('The assistant row is missing.');
    try {
      await glyph.waitForResponse();
      expect(await row.evaluate(element => element.isConnected)).toBe(true);
      expect(await row.textContent()).toContain('transport.');
    } finally {
      await row.dispose();
    }
  });

  it('submits a message with the platform command-enter shortcut', async ({ glyph }) => {
    await glyph.composer.fill('Send from the keyboard.');
    await glyph.composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await glyph.waitForResponse();
    await expect(glyph.userEntries.first()).toContainText('Send from the keyboard.');
  });

  it('keeps ordinary Enter as a newline and preserves multiline message text', async ({ glyph }) => {
    await glyph.composer.fill('First line');
    await glyph.composer.press('Enter');
    await glyph.composer.pressSequentially('Second line');
    await expect(glyph.composer).toHaveValue('First line\nSecond line');
    await expect(glyph.userEntries).toHaveCount(0);
    await glyph.sendButton.click();
    await glyph.waitForResponse();
    await expect(glyph.userEntries.first().locator('div')).toHaveText('First line\nSecond line');
  });

  it('ignores an empty or whitespace-only message without creating a conversation turn', async ({ glyph }) => {
    await glyph.sendButton.click();
    await glyph.send(' \n\t ');
    await expect(glyph.userEntries).toHaveCount(0);
    await expect(glyph.assistantEntries).toHaveCount(0);
    await expect(glyph.diagnostics).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });

  it('renders markup in a user message as literal text rather than creating HTML elements', async ({ glyph }) => {
    const message = '<strong>literal markup</strong> & <img src="fixture">';
    await glyph.send(message);
    await glyph.waitForResponse();
    await expect(glyph.userEntries.first().locator('div')).toHaveText(message);
    await expect(glyph.userEntries.locator('img')).toHaveCount(0);
  });

  it('cancels an answer in progress and lets the user send another message afterward', async ({ glyph }) => {
    await glyph.send('Cancel this answer.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    await glyph.sendButton.click();
    await expect(glyph.diagnostics).toContainText(['Response cancelled.']);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.assistantEntries.first()).not.toContainText('transport.');
    await glyph.send('Now answer another question.');
    await glyph.waitForResponse(1);
    await expect(glyph.userEntries).toHaveCount(2);
    await expect(glyph.assistantEntries).toHaveCount(2);
  });

  it('keeps successive conversation turns in order without overwriting earlier answers', async ({ glyph }) => {
    await glyph.send('First question.');
    await glyph.waitForResponse();
    await glyph.send('Second question.');
    await glyph.waitForResponse(1);
    await expect(glyph.userEntries.locator('div')).toHaveText(['First question.', 'Second question.']);
    await expect(glyph.assistantEntries).toHaveCount(2);
    await expect(glyph.assistantEntries.first()).toContainText('transport.');
  });

  it('can send another message after reloading the workbench window', async ({ glyph }) => {
    await glyph.send('Before reload.');
    await glyph.waitForResponse();
    const reloaded = glyph.page.waitForEvent('domcontentloaded');
    await glyph.command('Developer: Reload Window');
    await reloaded;
    await glyph.open();
    await glyph.send('After reload.');
    await expect(glyph.userEntries.last()).toContainText('After reload.');
    await expect(glyph.assistantEntries.last()).toContainText('transport.');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });

  it('restores completed conversation text after the workbench reconnects', async ({ glyph }) => {
    await glyph.send('Remember this conversation across a window reload.');
    await glyph.waitForResponse();
    const reloaded = glyph.page.waitForEvent('domcontentloaded');
    await glyph.command('Developer: Reload Window');
    await reloaded;
    await glyph.open();
    await expect(glyph.userEntries.locator('div')).toHaveText(['Remember this conversation across a window reload.']);
    await expect(glyph.assistantEntries).toHaveCount(1);
    await glyph.waitForResponse();
  });

  it('rejects a conversation request from a second window with overlapping workspace roots', async ({ glyph }) => {
    await glyph.send('Keep this workspace owned by the original window.');
    await glyph.waitForResponse();
    const duplicate = await glyph.duplicateWorkspace();
    await duplicate.send('Try to use the same files from the duplicated workspace.');
    await expect(duplicate.diagnostics).toContainText([/overlap.*owned by window/i]);
    await expect(duplicate.assistantEntries).toHaveCount(0);
    await glyph.send('The original workspace remains usable.');
    await glyph.waitForResponse(1);
  });
});

it.describe('An untrusted workspace', () => {
  it.use({ trustedWorkspace: false });
  it('prevents sending project context until the workspace is trusted', async ({ glyph }) => {
    await glyph.send('Do not expose this untrusted project.');
    await expect(glyph.diagnostics).toContainText([/Workspace trust is required/]);
    await expect(glyph.assistantEntries).not.toContainText(['The packaged Glyph host is connected']);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

it.describe('The production runtime with no configured account', () => {
  it.use({ productionRuntime: true });

  it('asks the user to sign in with inference access before sending a message', async ({ glyph }) => {
    await glyph.send('Explain this project.');
    await expect(glyph.diagnostics).toContainText([
      'Sign in to a Glyph account with inference access before sending a message.',
    ]);
    await expect(glyph.assistantEntries).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

// These product contracts intentionally remain visible as pending in --list and
// the HTML report. Enabling one requires a user-visible control and assertions;
// calling hidden services would bypass the behavior this suite promises to it.
it.describe('Pending desktop product contracts', () => {
  it.fixme(
    'renders a host question as an accessible answer form with a submit control connected to the waiting run',
    async () => {},
  );
  it.fixme(
    'renders a host approval with the requested operation and separate allow and deny controls connected to the waiting run',
    async () => {},
  );
  it.fixme(
    'renders proposal diffs with per-item accept and reject controls whose decisions are reflected in the review state',
    async () => {},
  );
  it.fixme('shows saved chats and opens the selected chat with its conversation history', async () => {});
  it.fixme('lets the user choose a connected account and model before starting a new chat', async () => {});
  it.fixme('shows reasoning and tool progress while an answer is running', async () => {});
  it.fixme('resumes a waiting answer after the user answers its question', async () => {});
  it.fixme('runs a requested operation only after the user approves it', async () => {});
  it.fixme('continues safely when the user declines an approval request', async () => {});
  it.fixme('attaches the selected unsaved editor text to the next message', async () => {});
  it.fixme('shows a proposed change without modifying the working copy before acceptance', async () => {});
  it.fixme('applies an accepted proposal to the live editor and supports Undo', async () => {});
  it.fixme('rejects a proposal without changing the editor or the file on disk', async () => {});
  it.fixme('refuses to apply a proposal after the user changes the referenced editor content', async () => {});
  it.fixme(
    'moves an oversized pasted text block into a separately inspectable attachment instead of filling the composer text area',
    async () => {},
  );
});

it.describe('Pending chat annotations', () => {
  it.fixme('lets the user highlight part of a prior message and comment on that exact passage', async () => {});
  it.fixme('attaches each comment together with its highlighted passage to the next outgoing message', async () => {});
  it.fixme('shows an N Annotations pill on the sent message and lets the user inspect its annotations', async () => {});
});

it.describe('Pending editor Tab completion', () => {
  it.fixme('offers an inline completion for the current editor context and accepts it with Tab', async () => {});
  it.fixme(
    'dismisses an inline completion without changing the document and never accepts a stale suggestion',
    async () => {},
  );
});

it.describe('Pending proposal rebuttals', () => {
  it.fixme(
    'offers Rebut beside Accept and Reject and opens a focused text input at the inline proposal',
    async () => {},
  );
  it.fixme(
    'attaches a rebuttal on Enter without applying the proposal and updates the composer’s N comments pill',
    async () => {},
  );
  it.fixme('shows each rebuttal’s filename and comment preview when hovering over the N comments pill', async () => {});
  it.fixme(
    'reopens and focuses the corresponding inline rebuttal input when its pill-list entry is clicked',
    async () => {},
  );
  it.fixme(
    'sends attached rebuttal comments with the next prompt so the agent can revise the rejected changes',
    async () => {},
  );
});

it.describe('Pending messages during an active turn', () => {
  it.fixme('queues a message with the queue shortcut without cancelling or steering the active turn', async () => {});
  it.fixme(
    'interrupts the active turn with the interrupt shortcut and starts the new message after cancellation settles',
    async () => {},
  );
  it.fixme('steers the active turn with the steering shortcut without starting a competing turn', async () => {});
  it.fixme('shows queued message previews stacked above the composer in their delivery order', async () => {});
  it.fixme(
    'moves a queued message back into the composer for editing without losing the existing draft',
    async () => {},
  );
  it.fixme(
    'lets the user reorder queued messages and delivers them in the new order after the active turn finishes',
    async () => {},
  );
  it.fixme('lets the user delete a queued message so it is never submitted', async () => {});
});

it.describe('Pending context compaction', () => {
  it.fixme('indicates when conversation context is being compacted and when the agent can continue', async () => {});
  it.fixme(
    'continues after compaction with the user’s instructions, unresolved decisions, and relevant tool results preserved',
    async () => {},
  );
  it.fixme(
    'keeps the visible conversation history available after the model context has been compacted',
    async () => {},
  );
  it.fixme(
    'reports a compaction failure without silently discarding context or duplicating the pending message',
    async () => {},
  );
});

it.describe('Pending usage metering and settings', () => {
  it.fixme(
    'shows input, cached input, output, reasoning, and total token usage for the selected conversation',
    async () => {},
  );
  it.fixme(
    'updates usage after a turn and restores the same totals after reconnecting without double-counting',
    async () => {},
  );
  it.fixme(
    'lets the user rebind send, queue, interrupt, and steer shortcuts through the workbench keyboard shortcut settings',
    async () => {},
  );
  it.fixme(
    'honors a rebound shortcut and removes the old binding without breaking ordinary composer text editing',
    async () => {},
  );
  it.fixme(
    'exposes supported Glyph options in Settings and preserves their values across a window reload',
    async () => {},
  );
});

// Hook return values below are product contracts, not instructions to the test runner.
// Each hook needs an isolated executable fixture and observable UI/side-effect assertions before enabling it.
it.describe('Pending conversation and tool hooks', () => {
  it.fixme(
    'runs sessionStart for a new conversation and applies returned environment variables and context without allowing it to block creation',
    async () => {},
  );
  it.fixme('runs sessionEnd when a conversation ends and logs but otherwise ignores its response', async () => {});
  it.fixme(
    'lets beforeSubmitPrompt return continue: false to block sending and show the hook’s message',
    async () => {},
  );
  it.fixme('lets preToolUse allow a tool call or deny it before any tool side effects occur', async () => {});
  it.fixme('uses preToolUse updated_input as the tool’s input instead of the original input', async () => {});
  it.fixme('adds postToolUse context after a successful tool result', async () => {});
  it.fixme('lets postToolUse replace the model-visible result of an MCP tool but not a non-MCP tool', async () => {});
  it.fixme(
    'runs postToolUseFailure after a tool error, timeout, or denial and adds its retry advice to context',
    async () => {},
  );
  it.fixme('honors beforeShellExecution allow and deny decisions before running a shell command', async () => {});
  it.fixme(
    'waits for the user’s approval when beforeShellExecution returns ask and does not execute a declined command',
    async () => {},
  );
  it.fixme(
    'passes the command, output, and duration to afterShellExecution without letting its response alter the outcome',
    async () => {},
  );
  it.fixme('honors beforeMCPExecution allow and deny decisions before invoking an MCP tool', async () => {});
  it.fixme(
    'waits for the user’s approval when beforeMCPExecution returns ask and does not invoke a declined tool',
    async () => {},
  );
  it.fixme(
    'passes the tool input and JSON result to afterMCPExecution as an observation-only notification',
    async () => {},
  );
  it.fixme(
    'honors beforeReadFile allow and deny decisions and keeps denied file contents out of model context',
    async () => {},
  );
  it.fixme(
    'notifies afterFileEdit of completed edits so a configured formatter can process the changed files',
    async () => {},
  );
  it.fixme(
    'honors subagentStart allow and deny decisions and treats ask as deny without launching a subagent',
    async () => {},
  );
  it.fixme(
    'delivers subagentStop followup_message to the finishing subagent so it can continue working',
    async () => {},
  );
  it.fixme(
    'submits stop followup_message automatically as the next user message after the agent’s turn ends',
    async () => {},
  );
  it.fixme(
    'shows the preCompact message but does not let its response block compaction or replace the summary',
    async () => {},
  );
  it.fixme(
    'passes the completed response text to afterAgentResponse as an observation-only notification',
    async () => {},
  );
  it.fixme(
    'passes provider-exposed thinking blocks and their duration to afterAgentThought without exposing private model reasoning',
    async () => {},
  );
});

it.describe('Pending Tab and workspace lifecycle hooks', () => {
  it.fixme(
    'honors beforeTabFileRead allow and deny decisions before reading context for an editor completion',
    async () => {},
  );
  it.fixme(
    'notifies afterTabFileEdit of accepted completion edits with their exact line and column ranges',
    async () => {},
  );
  it.fixme(
    'runs workspaceOpen when opening a workspace and loads the extra plugin directories returned in pluginPaths',
    async () => {},
  );
  it.fixme(
    'runs workspaceOpen again on each workspace folder change and loads newly returned pluginPaths',
    async () => {},
  );
});

it.describe('Pending language-server integration', () => {
  it.fixme(
    'uses language-server diagnostics and symbol information from the active project to answer code questions',
    async () => {},
  );
  it.fixme(
    'refreshes language-server context after unsaved edits instead of reporting stale diagnostics or symbol locations',
    async () => {},
  );
  it.fixme(
    'explains that language-server context is unavailable when the project has no language server',
    async () => {},
  );
});

it.describe('Pending cross-chat agent communication', () => {
  it.fixme('keeps two or more parallel chats independent until the user requests agent discovery', async () => {});
  it.fixme(
    'lets an agent discover other authorized parallel chats only after the user requests discovery',
    async () => {},
  );
  it.fixme(
    'delivers a message to the selected discovered chat and identifies the sending chat to the recipient',
    async () => {},
  );
  it.fixme(
    'lets the receiving chat reply to the sender without mixing either chat’s transcript or active turn',
    async () => {},
  );
  it.fixme('refuses discovery or messages outside the user-authorized set of chats', async () => {});
});
