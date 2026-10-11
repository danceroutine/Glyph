import { expect } from './playwright.mjs';

/** Drives only user-visible workbench interactions; never resolves internal services or IPC. */
export class GlyphWorkbench {
  constructor(page, application) {
    this.page = page;
    this.application = application;
    this.composer = page.getByRole('textbox', { name: 'Message Glyph', exact: true });
    this.sendButton = page.locator('.glyph-composer button');
    this.userEntries = page.locator('.glyph-transcript .glyph-entry.user');
    this.assistantEntries = page.locator('.glyph-transcript .glyph-entry.assistant');
    this.diagnostics = page.locator('.glyph-transcript .glyph-entry.diagnostic');
  }

  async command(name) {
    await this.page.keyboard.press('F1');
    const input = this.page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill(`>${name}`);
    await this.page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).first().click();
  }

  async open() {
    // The --disable-extensions notice can arrive after startup or between two
    // turns. Dismiss this known fixture-only toast through its visible control
    // whenever it obstructs an action, without hiding unexpected notifications.
    this.extensionNoticeHandler ??= this.page.addLocatorHandler(
      this.page.getByRole('dialog', { name: /All installed extensions are temporarily disabled/ }),
      async notice => {
        const composerWasFocused = await this.composer.and(this.page.locator(':focus')).count();
        await notice.getByRole('button', { name: /^Clear Notification/ }).click();
        if (composerWasFocused) await this.composer.focus();
      },
    );
    await this.extensionNoticeHandler;
    await expect(this.page.locator('.monaco-workbench')).toBeVisible({ timeout: 60_000 });
    await this.command('Focus Glyph');
    await expect(this.composer).toBeVisible();
  }

  async send(text) {
    await this.page.bringToFront();
    await this.composer.fill(text);
    await this.sendButton.click();
  }

  async duplicateWorkspace() {
    const opened = this.application.waitForEvent('window');
    await this.command('Duplicate As Workspace in New Window');
    const duplicate = new GlyphWorkbench(await opened, this.application);
    await duplicate.open();
    return duplicate;
  }

  async waitForResponse(index = 0) {
    await expect(this.assistantEntries.nth(index)).toContainText(
      'The packaged Glyph host is connected through the native utility-process transport.',
    );
    await expect(this.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  }
}
