import { expect } from './playwright.mjs';

/** Drives only user-visible workbench interactions; never resolves internal services or IPC. */
export class GlyphWorkbench {
  workspace = '';
  workspaceTarget = '';
  /** @type {string[]} */
  rootPaths = [];
  /** @type {Promise<void> | undefined} */
  extensionNoticeHandler;

  /**
   * @param {import('@playwright/test').Page} page
   * @param {import('@playwright/test').ElectronApplication} application
   */
  constructor(page, application) {
    this.page = page;
    this.application = application;
    this.composer = page.getByRole('textbox', { name: 'Message Glyph', exact: true });
    this.sendButton = page.locator('.glyph-composer .glyph-send');
    this.userEntries = page.locator('.glyph-transcript .glyph-entry.user');
    this.assistantEntries = page.locator('.glyph-transcript .glyph-entry.assistant');
    this.diagnostics = page.locator('.glyph-transcript .glyph-entry.diagnostic');
  }

  /** @param {string} name */
  async command(name) {
    await this.page.keyboard.press('F1');
    const input = this.page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill(`>${name}`);
    await this.page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).first().click();
  }

  async dismissExtensionNotices() {
    // The --disable-extensions notice can arrive after startup or between two
    // turns. Dismiss this known fixture-only toast through its visible control
    // whenever it obstructs an action, without hiding unexpected notifications.
    this.extensionNoticeHandler ??= this.page.addLocatorHandler(
      this.page.getByRole('dialog', { name: /All installed extensions are temporarily disabled/u }),
      async notice => {
        const composerWasFocused = await this.composer.and(this.page.locator(':focus')).count();
        const commandInput = this.page.locator('.quick-input-widget input');
        const command = (await commandInput.isVisible()) ? await commandInput.inputValue() : undefined;
        await notice.getByRole('button', { name: /^Clear Notification/u }).click();
        // Clicking a notification closes Quick Input. Restore the command
        // palette if this fixture-only notice interrupted a command action.
        if (command?.startsWith('>') === true) {
          await this.page.keyboard.press('F1');
          await commandInput.fill(command);
        } else if (composerWasFocused) await this.composer.focus();
      },
    );
    await this.extensionNoticeHandler;
  }

  async open() {
    await this.dismissExtensionNotices();
    await expect(this.page.locator('.monaco-workbench')).toBeVisible({ timeout: 60_000 });
    await this.command('Focus Glyph');
    await expect(this.composer).toBeVisible();
  }

  /** @param {string} text */
  async send(text) {
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

  async reload() {
    const reloaded = this.page.waitForEvent('domcontentloaded');
    await this.command('Developer: Reload Window');
    await reloaded;
    await this.open();
  }

  /** Fault injection is limited to the named utility child of this isolated test application. */
  async crashHost() {
    const pid = await this.application.evaluate(({ app }) => {
      const hosts = app
        .getAppMetrics()
        .filter(metric => metric.type === 'Utility' && metric.name?.startsWith('glyphHost-') === true);
      if (hosts.length !== 1) throw new Error(`Expected one fixture Glyph host, found ${hosts.length}.`);
      process.kill(hosts[0].pid, 'SIGKILL');
      return hosts[0].pid;
    });
    await expect
      .poll(() =>
        this.application.evaluate(
          ({ app }, processId) => app.getAppMetrics().some(metric => metric.pid === processId),
          pid,
        ),
      )
      .toBe(false);
  }

  async waitForResponse(index = 0) {
    await expect(this.assistantEntries.nth(index)).toContainText(
      'The packaged Glyph host is connected through the native utility-process transport.',
    );
    await expect(this.sendButton).toHaveText('Send (Enter)');
  }
}
