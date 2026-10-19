import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

for (const rebound of [false, true]) {
  it.describe(rebound ? 'Rebound composer commands' : 'Default composer commands', () => {
    const modifier = process.platform === 'darwin' ? 'cmd' : 'ctrl';
    it.use({
      scriptedProvider: true,
      userKeybindings: [
        rebound
          ? [
              { key: 'enter', command: '-glyph.sendMessage', when: 'glyph.composerFocus' },
              { key: `${modifier}+enter`, command: '-glyph.steerMessage', when: 'glyph.composerFocus' },
              { key: 'shift+enter', command: '-glyph.insertNewline', when: 'glyph.composerFocus' },
              { key: 'alt+s', command: 'glyph.sendMessage', when: 'glyph.composerFocus' },
              { key: 'alt+t', command: 'glyph.steerMessage', when: 'glyph.composerFocus' },
              { key: 'alt+enter', command: 'glyph.insertNewline', when: 'glyph.composerFocus' },
            ]
          : [],
        { scope: 'test' },
      ],
    });
    it('sends, inserts newlines, and steers without cancelling or starting a competing run', async ({
      glyph,
      provider,
    }) => {
      provider.enqueue({ chunks: ['I am still working.'], hold: true }, { chunks: ['Continuing with your guidance.'] });
      await glyph.composer.fill('First line');
      await glyph.composer.press(rebound ? 'Alt+Enter' : 'Shift+Enter');
      await glyph.composer.pressSequentially('Second line');
      expect(provider.requests).toHaveLength(0);
      await expect(glyph.composer.locator('p')).toHaveText(['First line', 'Second line']);
      await glyph.composer.press(rebound ? 'Alt+s' : 'Enter');
      await expect(glyph.assistantEntries).toContainText('I am still working.');
      await glyph.composer.fill('Keep the original task and also verify the tests.');
      if (rebound) {
        await glyph.composer.press('ControlOrMeta+Enter');
        await expect(glyph.userEntries).toHaveCount(1);
        await expect(glyph.composer).toContainText('Keep the original task');
      }
      await glyph.composer.press(rebound ? 'Alt+t' : 'ControlOrMeta+Enter');
      const bubble = glyph.page.locator('[data-steering="true"]');
      await expect(bubble).toContainText('Keep the original task');
      await expect(bubble).toHaveCSS('border-top-style', 'dotted');
      await expect(glyph.composer).toHaveText('');
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0].closed).toBe(false);
      provider.requests[0].finish();
      await expect(glyph.assistantEntries).toContainText('Continuing with your guidance.');
      await expect(glyph.assistantEntries).toHaveCount(1);
      expect(provider.requests).toHaveLength(2);
      const input = provider.requests[1].body.input;
      expect(input.filter(item => item.role === 'user')).toHaveLength(2);
      expect(JSON.stringify(input.at(-1))).toContain('Keep the original task');
      await expect(glyph.sendButton).not.toHaveText('Cancel');
      await glyph.reload();
      await expect(glyph.page.locator('[data-steering="true"]')).toContainText('Keep the original task');
      await expect(glyph.assistantEntries).toContainText('Continuing with your guidance.');
    });
  });
}
