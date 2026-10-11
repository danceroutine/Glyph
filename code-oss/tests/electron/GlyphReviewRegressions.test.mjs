import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

// These are deliberately ordinary tests, not fixmes or expected failures.
// They specify the desired behavior of reviewed defects and must remain red
// until the production implementation satisfies the assertions.

it.describe('Review regressions — utility-host failure', () => {
  it('[review-05] settles an in-flight send when the utility host exits and leaves the composer usable', async ({
    glyph,
  }) => {
    await glyph.send('Keep this run active while its host exits.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await expect(glyph.assistantEntries.first()).toContainText('The packaged');
    await crashFixtureHost(glyph);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.diagnostics).toContainText([/host|disconnect|interrupt/i]);
  });

  it('[review-05] acquires a live connection for a new send after the previous utility host has exited', async ({
    glyph,
  }) => {
    await glyph.send('Finish before the host exits.');
    await glyph.waitForResponse();
    await crashFixtureHost(glyph);
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

  it('[review-10] retains the unsent draft when no account has inference access', async ({ glyph }) => {
    const draft = 'Keep this unsent question until I have signed in.';
    await glyph.send(draft);
    await expect(glyph.diagnostics).toContainText([/Sign in.*inference access/]);
    await expect(glyph.composer).toHaveValue(draft);
    await expect(glyph.userEntries).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

it.describe('Review regressions — rejected send from an overlapping workspace', () => {
  it('[review-10] retains a rejected draft in a second window without changing the original conversation', async ({
    glyph,
  }) => {
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

/** Fault injection targets only the named child of this test's isolated Electron instance. */
async function crashFixtureHost(glyph) {
  const pid = await glyph.application.evaluate(({ app }) => {
    const hosts = app
      .getAppMetrics()
      .filter(metric => metric.type === 'Utility' && metric.name?.startsWith('glyphHost-'));
    if (hosts.length !== 1) throw new Error(`Expected one fixture Glyph host, found ${hosts.length}.`);
    const pid = hosts[0].pid;
    process.kill(pid, 'SIGKILL');
    return pid;
  });
  await expect
    .poll(() =>
      glyph.application.evaluate(({ app }, pid) => app.getAppMetrics().some(metric => metric.pid === pid), pid),
    )
    .toBe(false);
}
