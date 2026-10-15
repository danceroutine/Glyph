import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

// These are deliberately ordinary tests, not fixmes or expected failures.
// They specify the desired behavior of reviewed defects and must remain red
// until the production implementation satisfies the assertions.

it.describe('Review regressions — utility-host failure', () => {
  it('settles an in-flight send when the utility host exits and leaves the composer usable', async ({ glyph }) => {
    await glyph.send('Keep this run active while its host exits.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    await glyph.crashHost();
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.diagnostics).toContainText([/host|disconnect|interrupt/i]);
  });

  it('acquires a live connection for a new send after the previous utility host has exited', async ({ glyph }) => {
    await glyph.send('Finish before the host exits.');
    await glyph.waitForResponse();
    await glyph.crashHost();
    await glyph.send('Answer using a new live host connection.');
    const prompt = glyph.userEntries.filter({ hasText: 'Answer using a new live host connection.' });
    await expect(prompt).toBeVisible();
    // Require a response after the new prompt, not the old completed answer.
    // Recovery may replace history with a fresh authoritative host snapshot.
    const response = prompt.locator('xpath=following-sibling::*[1]');
    await expect(response).toHaveClass(/assistant/);
    await expect(response).toContainText('transport.');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

it.describe('Review regressions — rejected send with no account', () => {
  it.use({ productionRuntime: true });

  it('restarts the production host after a crash without manually removing its credential lock', async ({ glyph }) => {
    await glyph.send('Initialize the production account store without credentials.');
    await expect(glyph.diagnostics).toContainText([/Sign in.*inference access/]);
    await glyph.crashHost();
    await glyph.send('Reconnect to the production account store.');
    await expect(glyph.diagnostics.filter({ hasText: /Sign in.*inference access/ })).toHaveCount(2);
    await expect(glyph.composer).toHaveValue('Reconnect to the production account store.');
  });

  it('retains the unsent draft when no account has inference access', async ({ glyph }) => {
    const draft = 'Keep this unsent question until I have signed in.';
    await glyph.send(draft);
    await expect(glyph.diagnostics).toContainText([/Sign in.*inference access/]);
    await expect(glyph.composer).toHaveValue(draft);
    await expect(glyph.userEntries).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

it.describe('Review regressions — rejected send from an overlapping workspace', () => {
  it('retains a rejected draft in a second window without changing the original conversation', async ({ glyph }) => {
    await glyph.send('Keep ownership in this window.');
    await glyph.waitForResponse();
    const duplicate = await glyph.duplicateWorkspace();
    const draft = 'Do not discard this question when workspace ownership is denied.';
    await duplicate.send(draft);
    await expect(duplicate.diagnostics).toContainText([/overlap.*owned by window/i]);
    await expect(duplicate.composer).toHaveValue(draft);
    await expect(glyph.userEntries).toHaveCount(1);
  });
});
