import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';

const reloadsWindow = isolatedLaunch('reloads the window');
const createsRepository = isolatedLaunch('creates a Git repository and reloads the window');
const slowsSymbols = isolatedLaunch('switches the fixture extension to slow symbol results');
const firstTerminal = isolatedLaunch('expects the first terminal of a fresh window');
async function openFile(glyph, path) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill(path);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
  await expect(glyph.page.locator('.editor-instance .monaco-editor').first()).toBeVisible();
}
async function choose(glyph, label) {
  await glyph.page.locator('.quick-input-widget input').fill(label);
  await glyph.page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: label }).first().click();
}
async function capture(glyph, kind) {
  await glyph.command('Glyph: Attach IDE Context');
  await choose(glyph, kind);
}
async function send(glyph, provider) {
  const previous = provider.requests.length;
  provider.enqueue({ chunks: ['Context received.'] });
  await glyph.sendButton.click();
  await expect.poll(() => provider.requests.length).toBe(previous + 1);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const user = provider.requests
    .at(-1)
    .body.input.filter(item => item.role === 'user')
    .at(-1);
  return JSON.parse(user.content[0].text).files;
}

it.describe('Native IDE context captures', () => {
  it.describe.configure({ mode: 'default' });
  it.use({
    sharedLaunch: true,
    scriptedProvider: true,
    extensionDevelopmentPath: fileURLToPath(new URL('./fixtures/ide-context', import.meta.url)),
    workspaceFiles: {
      'slow.glyph': 'value = 123;\nvalue;\n',
      'invalid.json': '{ "sentinel": INVALID }\n',
      'plain.txt': 'EXPLICIT FILE FALLBACK\n',
      'definition.ts': 'export function greet(name: string) { return `Hello ${name}`; }\n',
      'caller.ts': 'import { greet } from "./definition";\nconst result = greet("Glyph");\n',
    },
  });

  it(
    'attaches a real diagnostic with its location and editor revision, preserving its captured history',
    reloadsWindow,
    async ({ glyph, provider }) => {
      await openFile(glyph, join(glyph.workspace, 'invalid.json'));
      await expect(glyph.page.locator('.squiggly-error').first()).toBeVisible({ timeout: 30000 });
      await capture(glyph, 'Diagnostic');
      await expect(glyph.page.locator('.quick-input-widget')).toContainText('invalid.json');
      await glyph.page.keyboard.press('Enter');
      await expect(glyph.composer.getByRole('button', { name: 'Open invalid.json' })).toBeVisible();
      await expect(glyph.page.getByRole('region', { name: 'Attachment preview' })).not.toBeVisible();
      await openFile(glyph, join(glyph.workspace, 'invalid.json'));
      await glyph.page.keyboard.press('ControlOrMeta+a');
      await glyph.page.keyboard.insertText('{ "fixed": true }');
      await glyph.open();
      const badge = glyph.composer.getByRole('button', { name: 'Open invalid.json' });
      await badge.hover();
      await expect(badge).toHaveAttribute('title', /Source changed; this capture is stale/);
      await glyph.composer.pressSequentially('Explain this problem');
      const files = await send(glyph, provider);
      expect(files[0].source).toMatchObject({
        kind: 'diagnostic',
        uri: expect.stringContaining('invalid.json'),
        range: { start: { line: 1, column: expect.any(Number) } },
        version: expect.any(Number),
      });
      expect(files[0].text).toContain('INVALID');
      await glyph.reload();
      await glyph.userEntries.getByRole('button', { name: 'Open invalid.json' }).click();
      await expect(glyph.page.locator('.tab.active')).toContainText('invalid.json');
    },
  );

  it('offers explicit file fallback when language services, diagnostics, or Git changes are unavailable', async ({
    glyph,
    provider,
  }) => {
    await openFile(glyph, join(glyph.workspace, 'plain.txt'));
    await capture(glyph, 'Related symbols');
    await expect(glyph.page.locator('.quick-input-widget')).toContainText('unavailable');
    await choose(glyph, 'Attach active file instead');
    await expect(glyph.composer.getByRole('button', { name: 'Preview plain.txt' })).toBeVisible();
    await glyph.composer.pressSequentially('Explain');
    const files = await send(glyph, provider);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ text: 'EXPLICIT FILE FALLBACK\n', source: { kind: 'file' } });
    await capture(glyph, 'Unstaged changes');
    await expect(glyph.page.locator('.quick-input-widget')).toContainText('No matching Git changes');
    await choose(glyph, 'Cancel');
    expect(provider.requests).toHaveLength(1);
  });

  it('finds definitions, references, and imports from the language service and refreshes after unsaved edits', async ({
    glyph,
    provider,
  }) => {
    await openFile(glyph, join(glyph.workspace, 'caller.ts'));
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await capture(glyph, 'Related symbols');
    await expect(glyph.composer.getByRole('button', { name: /Open/ }).first()).toBeVisible({ timeout: 30000 });
    await glyph.composer.pressSequentially('Explain these symbols');
    const files = await send(glyph, provider);
    expect(files.some(file => file.path === 'definition.ts' && file.text.includes('definition:'))).toBe(true);
    expect(files.some(file => file.text.includes('reference:'))).toBe(true);
    expect(files.some(file => file.text.includes('Import declaration (lexical match)'))).toBe(true);
    await glyph.userEntries.getByRole('button', { name: 'Open definition.ts' }).first().click();
    await expect(glyph.page.locator('.tab.active')).toContainText('definition.ts');
    await openFile(glyph, join(glyph.workspace, 'caller.ts'));
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await glyph.page.keyboard.insertText('const freshSymbol = 42;\nfreshSymbol;\n');
    await glyph.page.keyboard.press('ControlOrMeta+a');
    await capture(glyph, 'Related symbols');
    await expect(glyph.composer.getByRole('button', { name: /Open/ }).first()).toBeVisible();
    await glyph.composer.pressSequentially('Explain the new symbols');
    const refreshed = await send(glyph, provider);
    expect(refreshed[0].text).toContain('freshSymbol');
    expect(refreshed.every(file => file.path !== 'definition.ts')).toBe(true);
    expect(refreshed[0].source.revision).not.toBe(files[0].source.revision);
  });

  it(
    'captures staged and unstaged changes against explicit bases without reading unrelated history',
    createsRepository,
    async ({ glyph, provider }) => {
      const git = (...args) =>
        execFileSync('git', args, { cwd: glyph.workspace, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
      git('init');
      git('config', 'user.email', 'fixture@example.invalid');
      git('config', 'user.name', 'Fixture');
      await writeFile(join(glyph.workspace, 'tracked.txt'), 'BASE\n');
      git('add', 'tracked.txt');
      git('commit', '-m', 'Fixture base');
      await writeFile(join(glyph.workspace, 'tracked.txt'), 'INDEX\n');
      git('add', 'tracked.txt');
      await writeFile(join(glyph.workspace, 'tracked.txt'), 'WORKTREE\n');
      await glyph.reload();
      await openFile(glyph, join(glyph.workspace, 'tracked.txt'));
      await glyph.command('Git: Refresh');
      await capture(glyph, 'Staged changes');
      await choose(glyph, 'tracked.txt');
      await expect(glyph.composer.getByRole('button', { name: 'Open tracked.txt' })).toBeVisible();
      await glyph.composer.pressSequentially('Explain staged');
      const staged = await send(glyph, provider);
      expect(staged[0].text).toContain('HEAD → index');
      expect(staged[0].text).toContain('-BASE\n+INDEX');
      expect(staged[0].text).not.toContain('WORKTREE');
      await capture(glyph, 'Unstaged changes');
      await choose(glyph, 'tracked.txt');
      await expect(glyph.composer.getByRole('button', { name: 'Open tracked.txt' })).toBeVisible();
      await glyph.composer.pressSequentially('Explain unstaged');
      const unstaged = await send(glyph, provider);
      expect(unstaged[0].text).toContain('index → working tree');
      expect(unstaged[0].text).toContain('-INDEX\n+WORKTREE');
      expect(unstaged[0].text).toContain('Base SHA-256:');
      expect(unstaged[0].source.kind).toBe('diff');
      await unlink(join(glyph.workspace, 'tracked.txt'));
      await glyph.command('Git: Refresh');
      await capture(glyph, 'Unstaged changes');
      await choose(glyph, 'tracked.txt');
      await expect(glyph.composer.getByRole('button', { name: 'Open tracked.txt' })).toBeVisible();
      await glyph.composer.pressSequentially('Explain the unstaged deletion');
      const deletion = await send(glyph, provider);
      expect(deletion[0].text).toContain('+++ /dev/null');
      expect(deletion[0].text).toContain('-INDEX');
      expect(deletion[0].text).not.toContain('-BASE');
    },
  );
  it(
    'discards symbol results that arrive after the selected editor changes and labels the stale capture',
    slowsSymbols,
    async ({ glyph, provider }) => {
      await openFile(glyph, join(glyph.workspace, 'slow.glyph'));
      await glyph.command('Glyph Fixture: Slow Symbol Results');
      await glyph.page.keyboard.press('ControlOrMeta+a');
      await capture(glyph, 'Related symbols');
      // Query is in flight; edit the native model without touching the captured composer draft.
      await glyph.page.locator('.editor-instance .monaco-editor').first().click();
      await glyph.page.keyboard.press('ControlOrMeta+a');
      await glyph.page.keyboard.insertText('replacement = 456;');
      await expect(glyph.composer.getByRole('button', { name: /Open/ }).first()).toBeVisible();
      await glyph.composer.pressSequentially('Explain stale context');
      const files = await send(glyph, provider);
      expect(files).toHaveLength(1);
      expect(files[0].text).toContain('stale: editor changed');
      expect(files[0].text).toContain('value');
      expect(files[0].text).not.toContain('replacement');
    },
  );

  it(
    'captures explicitly chosen test output with its originating run and restores its kind after reopening',
    reloadsWindow,
    async ({ glyph, provider }) => {
      await glyph.command('Glyph Fixture: Produce Test Output');
      await capture(glyph, 'Test output');
      await choose(glyph, 'Deterministic output run');
      await expect(glyph.composer.getByRole('button', { name: /Open Test output/ })).toBeVisible();
      await glyph.composer.pressSequentially('Explain the test output');
      const files = await send(glyph, provider);
      expect(files[0]).toMatchObject({ source: { kind: 'test' } });
      expect(files[0].text).toContain('FIRST TEST OUTPUT');
      expect(files[0].text).toContain('Run ID:');
      expect(files[0].text).toContain('Controller: glyph-fixture-tests');
      await glyph.userEntries.getByRole('button', { name: /Open Test output/ }).click();
      await glyph.page.keyboard.press('Control+g');
      await glyph.page.locator('.quick-input-widget input').fill(':2:1');
      await glyph.page.keyboard.press('Enter');
      await glyph.page.keyboard.press('Shift+End');
      await glyph.page.keyboard.press('ControlOrMeta+l');
      await expect(glyph.composer.getByRole('button', { name: /Open Test output/ })).toBeVisible();
      await glyph.composer.pressSequentially('Explain this selected line');
      const selected = await send(glyph, provider);
      expect(selected[0].text).toContain('Selected test output:\nselected evidence');
      expect(selected[0].text).not.toContain('FIRST TEST OUTPUT');
      expect(selected[0].source).toMatchObject({ kind: 'test', range: { start: { line: 2, column: 1 } } });
      await glyph.reload();
      await glyph.userEntries.last().hover();
      await glyph.userEntries.last().getByRole('button', { name: 'Restore checkpoint' }).click();
      const restored = await send(glyph, provider);
      expect(restored).toEqual(selected);
    },
  );

  it(
    'captures only selected native terminal output and labels unavailable command attribution',
    firstTerminal,
    async ({ glyph, provider }) => {
      await glyph.command('Terminal: Create New Terminal');
      const input = glyph.page.getByRole('textbox', { name: /^Terminal 1,/ });
      await expect(input).toBeFocused();
      await input.pressSequentially("printf 'TERMINAL_CAPTURE_SENTINEL\\n'");
      await input.press('Enter');
      await glyph.command('Terminal: Select All');
      await capture(glyph, 'Terminal selection');
      await expect(glyph.composer.getByRole('button', { name: /Open Terminal/ })).toBeVisible();
      await glyph.composer.pressSequentially('Explain terminal output');
      const files = await send(glyph, provider);
      expect(files[0].source.kind).toBe('terminal');
      expect(files[0].text).toContain('TERMINAL_CAPTURE_SENTINEL');
      expect(files[0].text).toContain('Command: unavailable:');
      await glyph.reload();
      await glyph.userEntries.getByRole('button', { name: /Open Terminal/ }).click();
      await expect(
        glyph.page.getByText('Terminal closed. The captured output is preserved.', { exact: false }).first(),
      ).toBeVisible();
    },
  );
});
