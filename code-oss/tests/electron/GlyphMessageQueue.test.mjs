import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.describe('Queued follow-ups', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });
  it('reorders and edits queued messages before delivering them as separate turns', async ({ glyph, provider }) => {
    provider.enqueue(
      { chunks: ['Working on the original task.'], hold: true },
      { chunks: ['Second task complete.'] },
      { chunks: ['First revised task complete.'] },
    );
    await glyph.send('Original task');
    await expect(glyph.assistantEntries).toContainText('Working on the original task.');
    const queue = glyph.page.getByRole('region', { name: 'Queued messages', exact: true });
    for (const text of ['First task', 'Second task', 'Discard this']) {
      await glyph.composer.fill(text);
      await glyph.composer.press('Enter');
    }
    await expect(queue.getByRole('listitem')).toHaveCount(3);
    await queue.getByRole('listitem').last().hover();
    await queue
      .getByRole('listitem')
      .last()
      .getByRole('button', { name: 'Remove queued message', exact: true })
      .click();
    await expect(queue.getByRole('listitem')).toHaveCount(2);
    const rows = queue.getByRole('listitem');
    await expect(rows.first()).toHaveCSS('cursor', 'grab');
    await rows.nth(1).dragTo(rows.first());
    await expect(rows.first()).toContainText('Second task');
    await glyph.composer.fill('Preserve my newer draft');
    await rows.nth(1).hover();
    await rows.nth(1).getByRole('button', { name: 'Edit queued message', exact: true }).click();
    await expect(glyph.page.getByRole('region', { name: 'Unsent messages' })).toContainText('Preserve my newer draft');
    await glyph.composer.fill('First revised task');
    await glyph.composer.press('Enter');
    await expect(rows.nth(1)).toContainText('First revised task');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].closed).toBe(false);
    provider.requests[0].finish();
    await expect(glyph.assistantEntries).toHaveCount(3);
    await expect(glyph.assistantEntries.last()).toContainText('First revised task complete.');
    await expect(queue).toHaveCount(0);
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[1].body.input.at(-1))).toContain('Second task');
    expect(JSON.stringify(provider.requests[2].body.input.at(-1))).toContain('First revised task');
  });
  it('sends a queued message immediately by cancelling and settling the current run first', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Working.'], hold: true }, { chunks: ['Urgent task complete.'] });
    await glyph.send('Original task');
    await expect(glyph.assistantEntries).toContainText('Working.');
    await glyph.composer.fill('Urgent task');
    await glyph.composer.press('Enter');
    const queue = glyph.page.getByRole('region', { name: 'Queued messages', exact: true });
    await queue.getByRole('listitem').hover();
    await queue.getByRole('button', { name: 'Send queued message immediately', exact: true }).click();
    await expect(glyph.assistantEntries).toHaveCount(2);
    await expect(glyph.assistantEntries.last()).toContainText('Urgent task complete.');
    expect(provider.requests[0].closed).toBe(true);
    expect(provider.requests).toHaveLength(2);
    await expect(queue).toHaveCount(0);
  });
});
it.describe('Queued message menu', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });
  it('opens message settings and moves a queued document into a new chat without interrupting the old run', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Original work continues.'], hold: true });
    await glyph.send('Original task');
    await expect(glyph.assistantEntries).toContainText('Original work continues.');
    await glyph.composer.fill('Move this to a new chat');
    await glyph.composer.press('Enter');
    const queue = glyph.page.getByRole('region', { name: 'Queued messages', exact: true });
    await queue.getByRole('listitem').hover();
    await queue.getByRole('button', { name: 'Queued message actions', exact: true }).click();
    await queue.getByRole('menuitem', { name: 'New Message Settings', exact: true }).click();
    await expect(glyph.page.getByRole('treeitem', { name: /Glyph › Chat Follow Up Behavior/u })).toBeVisible();
    await glyph.page.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    await queue.getByRole('listitem').hover();
    await queue.getByRole('button', { name: 'Queued message actions', exact: true }).click();
    await queue.getByRole('menuitem', { name: 'Move to New Chat', exact: true }).click();
    await expect(glyph.composer).toHaveText('Move this to a new chat');
    await expect(queue).toHaveCount(0);
    await expect(glyph.userEntries).toHaveCount(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].closed).toBe(false);
    provider.requests[0].finish();
  });
});
it.describe('Immediate follow-up setting', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
    scriptedProvider: true,
    userSettings: { 'glyph.chat.followUpBehavior': 'sendImmediately' },
  });
  it('makes Enter interrupt and send a normal message while steering remains separate', async ({ glyph, provider }) => {
    provider.enqueue({ chunks: ['Working.'], hold: true }, { chunks: ['New turn complete.'] });
    await glyph.send('Original task');
    await expect(glyph.assistantEntries).toContainText('Working.');
    await glyph.composer.fill('Replacement task');
    await expect(glyph.sendButton).toHaveText('Send immediately');
    await glyph.composer.press('Enter');
    await expect(glyph.assistantEntries).toHaveCount(2);
    await expect(glyph.assistantEntries.last()).toContainText('New turn complete.');
    expect(provider.requests[0].closed).toBe(true);
    await expect(glyph.page.getByRole('region', { name: 'Queued messages', exact: true })).toHaveCount(0);
  });
});
