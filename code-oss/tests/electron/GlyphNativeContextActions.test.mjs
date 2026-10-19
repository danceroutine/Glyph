import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
async function openFile(glyph, path) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill(path);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
}
const files = provider =>
  JSON.parse(
    provider.requests
      .at(-1)
      .body.input.filter(item => item.role === 'user')
      .at(-1).content[0].text,
  ).files;
it.describe('Context actions on native workbench surfaces', () => {
  it.use({
    scriptedProvider: true,
    extensionDevelopmentPath: fileURLToPath(new URL('./fixtures/ide-context', import.meta.url)),
    workspaceFiles: { 'invalid.json': '{ "sentinel": INVALID }\n', 'slow.glyph': 'value = 123;\nvalue;\n' },
  });
  it('fixes the exact hovered diagnostic and preserves an unrelated draft', async ({ glyph, provider }) => {
    await glyph.composer.pressSequentially('Keep this draft');
    await openFile(glyph, join(glyph.workspace, 'invalid.json'));
    const error = glyph.page.locator('.squiggly-error').first();
    await expect(error).toBeVisible({ timeout: 30000 });
    await glyph.page
      .locator('.view-line span')
      .filter({ hasText: /^INVALID$/ })
      .hover();
    const fix = glyph.page.getByRole('button', { name: 'Fix with Agent', exact: true });
    await expect(fix).toBeVisible();
    provider.enqueue({ chunks: ['I checked the diagnostic.'] });
    await fix.click();
    await expect.poll(() => provider.requests.length).toBe(1);
    expect(files(provider)[0].source.kind).toBe('diagnostic');
    expect(files(provider)[0].text).toContain('INVALID');
    await expect(glyph.page.getByRole('region', { name: 'Unsent messages' })).toContainText('Keep this draft');
  });
  it('offers Add to Chat on a terminal selection and captures only that terminal', async ({ glyph, provider }) => {
    await glyph.command('Terminal: Create New Terminal');
    const input = glyph.page.getByRole('textbox', { name: /^Terminal 1,/ });
    await expect(input).toBeFocused();
    await input.pressSequentially("printf 'NATIVE_SELECTION_EVIDENCE\\n'");
    await input.press('Enter');
    await glyph.command('Terminal: Select All');
    const add = glyph.page.getByRole('button', { name: /^Add to Chat/ });
    await expect(add).toBeVisible();
    await add.click();
    await expect(glyph.composer.getByRole('button', { name: /Open Terminal/ })).toBeVisible();
    await expect(glyph.page.getByRole('region', { name: 'Attachment preview' })).not.toBeVisible();
    await glyph.composer.pressSequentially('Explain this output');
    provider.enqueue({ chunks: ['Output received.'] });
    await glyph.sendButton.click();
    await expect.poll(() => provider.requests.length).toBe(1);
    expect(files(provider)[0].text).toContain('NATIVE_SELECTION_EVIDENCE');
    await expect(add).not.toBeVisible();
  });
  it('fixes the failure from the native test peek', async ({ glyph, provider }) => {
    await openFile(glyph, join(glyph.workspace, 'slow.glyph'));
    await glyph.command('Glyph Fixture: Produce Test Output');
    await glyph.command('Test: Peek Output');
    const fix = glyph.page.getByRole('button', { name: 'Fix with Agent', exact: true });
    await expect(fix).toBeVisible();
    provider.enqueue({ chunks: ['I checked this test failure.'] });
    await fix.click();
    await expect.poll(() => provider.requests.length).toBe(1);
    expect(files(provider)[0].source.kind).toBe('test');
    expect(files(provider)[0].source.uri).toContain('TestFailureMessage');
    expect(files(provider)[0].text).toContain('Deliberate fixture failure');
  });
  it('disables unavailable review scopes and reacts to commits and staged changes', async ({ glyph, provider }) => {
    await glyph.command('Glyph: Open Agent Review');
    const review = glyph.page.getByRole('button', { name: 'Find Issues', exact: true });
    const scope = glyph.page.getByRole('combobox', { name: 'Review scope' });
    await expect(review).toBeDisabled();
    await expect(scope).toBeDisabled();
    const git = (...args) => execFileSync('git', args, { cwd: glyph.workspace });
    git('init', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Glyph Fixture');
    await writeFile(join(glyph.workspace, 'review.txt'), 'FIRST_COMMIT\n');
    git('add', 'review.txt');
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Git history is unavailable' })).toBeVisible({
      timeout: 30000,
    });
    await expect(review).toBeDisabled();
    await expect(scope).toBeDisabled();
    git('commit', '-m', 'initial');
    await expect(review).toBeEnabled({ timeout: 30000 });
    await expect(scope).toBeEnabled();
    await scope.click();
    await glyph.page.getByRole('option', { name: 'Staged changes', exact: true }).click();
    await expect(review).toBeDisabled({ timeout: 30000 });
    await expect(glyph.page.getByRole('status').filter({ hasText: 'There are no changes' })).toBeVisible();
    await expect(scope).toBeDisabled();
    await writeFile(join(glyph.workspace, 'review.txt'), 'STAGED_CHANGE\n');
    git('add', 'review.txt');
    await expect(review).toBeEnabled({ timeout: 30000 });
    await expect(scope).toBeEnabled();
    await scope.click();
    await glyph.page.getByRole('option', { name: 'Last commit', exact: true }).click();
    await expect(review).toBeEnabled();
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Git history is unavailable' })).not.toBeVisible();
    expect(provider.requests).toHaveLength(0);
  });
  it('reviews last commit by default, persists staged scope, and uses the selected branch comparison', async ({
    glyph,
    provider,
  }) => {
    const git = (...args) => execFileSync('git', args, { cwd: glyph.workspace });
    git('init', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Glyph Fixture');
    await writeFile(join(glyph.workspace, 'review.txt'), 'FIRST_COMMIT\n');
    git('add', 'review.txt');
    git('commit', '-m', 'initial');
    git('switch', '-c', 'feature');
    await writeFile(join(glyph.workspace, 'review.txt'), 'LAST_COMMIT\n');
    git('add', 'review.txt');
    git('commit', '-m', 'feature');
    await writeFile(join(glyph.workspace, 'review.txt'), 'STAGED_ONLY\n');
    git('add', 'review.txt');
    await writeFile(join(glyph.workspace, 'review.txt'), 'WORKTREE_ONLY\n');
    await glyph.command('Glyph: Open Agent Review');
    const scope = glyph.page.getByRole('combobox', { name: 'Review scope' });
    await expect(scope).toHaveAttribute('title', 'Review scope: Last commit');
    // Wait for built-in Git to discover the repository created after startup.
    await expect(glyph.page.locator('.scm-view').first()).toContainText('review.txt', { timeout: 30000 });
    provider.enqueue({ chunks: ['No issues found.'] });
    await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
    await expect.poll(() => provider.requests.length).toBe(1);
    expect(files(provider)[0].text).toContain('FIRST_COMMIT');
    expect(files(provider)[0].text).toContain('LAST_COMMIT');
    expect(files(provider)[0].text).not.toContain('STAGED_ONLY');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await scope.click();
    await glyph.page.getByRole('option', { name: 'Staged changes', exact: true }).click();
    await expect(scope).toHaveAttribute('title', 'Review scope: Staged changes');
    provider.enqueue({ chunks: ['Staged review complete.'] });
    await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
    await expect.poll(() => provider.requests.length).toBe(2);
    expect(files(provider)[0].text).toContain('STAGED_ONLY');
    expect(files(provider)[0].text).not.toContain('WORKTREE_ONLY');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.reload();
    await glyph.command('Glyph: Open Agent Review');
    await expect(scope).toHaveAttribute('title', 'Review scope: Staged changes');
    await scope.click();
    await glyph.page.getByRole('option', { name: 'Compare against branch', exact: true }).click();
    await glyph.page.locator('.quick-input-widget input').fill('main');
    await glyph.page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'main' }).first().click();
    provider.enqueue({ chunks: ['Branch review complete.'] });
    await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
    await expect.poll(() => provider.requests.length).toBe(3);
    expect(files(provider)[0].text).toContain('merge base');
    expect(files(provider)[0].text).toContain('FIRST_COMMIT');
    expect(files(provider)[0].text).toContain('LAST_COMMIT');
    expect(files(provider)[0].text).not.toContain('WORKTREE_ONLY');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await scope.click();
    await glyph.page.getByRole('option', { name: 'All local changes', exact: true }).click();
    provider.enqueue({ chunks: ['Local review complete.'] });
    await glyph.page.getByRole('button', { name: 'Find Issues', exact: true }).click();
    await expect.poll(() => provider.requests.length).toBe(4);
    const localFile = files(provider).find(file => file.path === 'review.txt');
    expect(localFile.text).toContain('LAST_COMMIT');
    expect(localFile.text).toContain('WORKTREE_ONLY');
    expect(localFile.text).not.toContain('STAGED_ONLY');
  });
});
