import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.describe('Docked chat history', () => {
  it.use({ scriptedProvider: true });

  it('expands the native panel beside the conversation and restores its width when closed', async ({ glyph }) => {
    const panel = glyph.page.locator('.part.auxiliarybar');
    const conversation = glyph.page.getByRole('main', { name: 'Current conversation' });
    const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
    const history = glyph.page.getByRole('complementary', { name: 'Chat history' });
    const before = await panel.boundingBox();
    const chatBefore = await conversation.boundingBox();
    await glyph.composer.fill('Keep this draft while browsing history');
    for (let attempt = 0; attempt < 2; attempt++) {
      await toggle.click();
      await expect(history).toBeVisible();
      await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(before.width + 200);
      const chat = await conversation.boundingBox();
      const sidebar = await history.boundingBox();
      expect(Math.abs(chat.width - chatBefore.width)).toBeLessThan(2);
      expect(Math.abs(chat.x + chat.width - sidebar.x)).toBeLessThan(2);
      await expect(glyph.composer).toBeEditable();
      await glyph.composer.fill('Conversation stays usable alongside history');
      await glyph.page.getByRole('searchbox', { name: 'Search chats' }).focus();
      await glyph.page.keyboard.press('Escape');
      await expect(history).toHaveCount(0);
      await expect.poll(async () => (await panel.boundingBox()).width).toBe(before.width);
      await expect(toggle).toBeFocused();
    }
    await expect(glyph.composer).toHaveText('Conversation stays usable alongside history');
  });
});
