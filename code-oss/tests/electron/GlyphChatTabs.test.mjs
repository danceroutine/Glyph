import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.use({ scriptedProvider: true });
const tabs = glyph => glyph.page.getByRole('tablist', { name: 'Open chats' });

it('uses one compact header and keeps tabs, drafts, and saved chats independent', async ({ glyph, provider }) => {
  const panel = glyph.page.locator('.part.auxiliarybar');
  const header = glyph.page.locator('.glyph-chat-header');
  await expect(panel.locator(':scope > .title')).toBeHidden();
  expect((await header.boundingBox()).height).toBeLessThanOrEqual(36);
  expect((await header.boundingBox()).y - (await panel.boundingBox()).y).toBeLessThan(12);
  await panel.screenshot({ path: it.info().outputPath('chat-header.png') });
  provider.enqueue({ chunks: ['First answer.'] }, { chunks: ['Second answer.'] });
  await glyph.send('First task');
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await glyph.composer.fill('Keep first draft');
  await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(2);
  await glyph.send('Second task');
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(2);
  await tabs(glyph).getByRole('tab', { name: 'First Task', exact: true }).click();
  await expect(glyph.composer).toHaveText('Keep first draft');
  await tabs(glyph).getByRole('tab', { name: 'First Task', exact: true }).press('ArrowRight');
  await expect(tabs(glyph).getByRole('tab', { name: 'Second Task', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await tabs(glyph).getByRole('button', { name: 'Close First Task', exact: true }).click();
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(1);
  await glyph.page.getByRole('button', { name: 'Recent chats', exact: true }).click();
  const picker = glyph.page.getByRole('dialog', { name: 'Recent chats', exact: true });
  await picker.getByRole('button', { name: 'First Task', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(2);
  await expect(glyph.composer).toHaveText('Keep first draft');
  await glyph.reload();
  await expect(panel.locator(':scope > .title')).toBeHidden();
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(2);
  await expect(tabs(glyph).getByRole('tab', { name: 'First Task', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

it('changes header controls with the sidebar and restores archived chats from the clock picker', async ({
  glyph,
  provider,
}) => {
  provider.enqueue({ chunks: ['Review complete.'] });
  await glyph.send('Archive example');
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const header = glyph.page.locator('.glyph-chat-header');
  await expect(header.getByRole('button', { name: 'Recent chats' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Chat actions' })).toBeVisible();
  await glyph.page.getByRole('button', { name: 'Chat history', exact: true }).click();
  const sidebar = glyph.page.getByRole('complementary', { name: 'Chat history' });
  await expect(sidebar).toBeVisible();
  await expect(header.getByRole('button', { name: 'Recent chats' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Chat history' })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Chat history', exact: true })).toHaveAttribute(
    'title',
    'Close sidebar',
  );
  await sidebar.getByRole('button', { name: 'Archive Example', exact: true }).hover();
  await sidebar.getByRole('button', { name: 'Pin Archive Example', exact: true }).click();
  await expect(sidebar.getByRole('region', { name: 'Pinned', exact: true })).toContainText('Archive Example');
  await sidebar.getByRole('button', { name: 'Archive Example', exact: true }).hover();
  await sidebar.getByRole('button', { name: 'Archive Archive Example', exact: true }).click();
  await sidebar.getByRole('button', { name: 'Chat history', exact: true }).click();
  await glyph.reload();
  await glyph.page.getByRole('button', { name: 'Recent chats', exact: true }).click();
  const picker = glyph.page.getByRole('dialog', { name: 'Recent chats' });
  await picker.getByRole('button', { name: /Archived/ }).click();
  const archived = picker.getByRole('region', { name: 'Archived chats' });
  await expect(archived).toContainText('Archive Example');
  await archived.getByRole('button', { name: 'Archive Example', exact: true }).hover();
  await archived.getByRole('button', { name: 'Unarchive Archive Example', exact: true }).click();
  await picker.getByRole('button', { name: 'Archive Example', exact: true }).click();
  await expect(glyph.userEntries).toContainText('Archive example');
  await glyph.page.getByRole('button', { name: 'Chat actions' }).click();
  const menu = glyph.page.getByRole('menu', { name: 'Chat actions' });
  await expect(menu.getByRole('menuitem', { name: 'Export Transcript' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Agent Settings' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Close All Chat Tabs' }).click();
  await expect(tabs(glyph).getByRole('tab', { name: 'New chat', exact: true })).toBeVisible();
  await expect(tabs(glyph).getByRole('tab')).toHaveCount(1);
});
