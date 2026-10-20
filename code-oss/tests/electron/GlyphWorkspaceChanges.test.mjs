import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

it.use({ scriptedProvider: true, workspaceFiles: { 'kept.txt': 'ORIGINAL CAPTURE' } });

it.beforeEach(async ({ glyph }) => {
  await expect(glyph.page.getByRole('combobox', { name: 'Model', exact: true })).toContainText('Scripted model');
  await expect(glyph.sendButton).toBeEnabled();
});

async function attach(glyph, file) {
  await glyph.page.keyboard.press('ControlOrMeta+p');
  await glyph.page.locator('.quick-input-widget input').fill(file);
  await glyph.page.keyboard.press('Enter');
  await expect(glyph.page.locator('.quick-input-widget')).not.toBeVisible();
  await expect(glyph.page.locator('.editor-instance .monaco-editor').first()).toBeVisible();
  await glyph.page.keyboard.press('ControlOrMeta+a');
  await glyph.page.keyboard.press('ControlOrMeta+l');
}
async function read(glyph, provider, path) {
  const count = provider.requests.length;
  provider.enqueue(
    {
      output: [
        ScriptedProvider.tool(
          'read_project_file',
          { path, start_line: null, end_line: null },
          { callId: 'read-new-root' },
        ),
      ],
    },
    { chunks: ['Read the updated workspace.'] },
  );
  await glyph.send('Read the updated workspace file.');
  await expect.poll(() => provider.requests.length).toBe(count + 2);
  await expect(glyph.sendButton).toHaveText('Send (Enter)');
  return provider.requests
    .at(-1)
    .body.input.filter(item => item.type === 'function_call_output')
    .at(-1).output;
}

it.describe('single-folder conversion', () => {
  it.use({ extensionDevelopmentPath: resolve('code-oss/tests/electron/fixtures/workspace-changes') });
  it('adds a folder without reloading, preserves a draft and chat, and keeps history after reload', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Original conversation.'] });
    await glyph.send('Remember this conversation');
    await expect.poll(() => provider.requests.length).toBe(1);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.composer.fill('Keep this draft ');
    await attach(glyph, join(glyph.workspace, 'kept.txt'));
    const added = join(dirname(glyph.workspace), 'added');
    await mkdir(added);
    await writeFile(join(added, 'new.txt'), 'NEW ROOT CONTENT');
    await glyph.command('Glyph Fixture: Add Workspace Folder');
    await glyph.page.locator('.quick-input-widget input').fill(added);
    await glyph.page.keyboard.press('Enter');
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Workspace updated:' })).toBeVisible();
    await expect(glyph.composer).toContainText('Keep this draft');
    await expect(glyph.composer).toContainText('kept.txt');
    await expect(glyph.userEntries).toHaveCount(1);
    await writeFile(join(glyph.workspace, 'kept.txt'), 'CHANGED AFTER CAPTURE');
    provider.enqueue({ chunks: ['Received the original capture.'] });
    await glyph.sendButton.click();
    await expect.poll(() => provider.requests.length).toBe(2);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    const user = provider.requests[1].body.input.filter(item => item.role === 'user').at(-1);
    expect(JSON.parse(user.content[0].text).files).toEqual([
      expect.objectContaining({ path: 'workspace/kept.txt', text: 'ORIGINAL CAPTURE' }),
    ]);
    expect(await read(glyph, provider, 'added/new.txt')).toContain('NEW ROOT CONTENT');
    await glyph.reload();
    await expect(glyph.userEntries).toHaveCount(3);
    await expect(glyph.userEntries.first()).toContainText('Remember this conversation');
  });
});

it.describe('saved workspace folder changes', () => {
  it.use({ additionalRoots: [{ name: 'other', files: { 'kept.txt': 'OTHER ROOT CONTENT' } }] });
  it('marks removed-folder captures unavailable and restricts tools to the remaining roots', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Saved conversation.'] });
    await glyph.send('Remember this conversation');
    await expect.poll(() => provider.requests.length).toBe(1);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await attach(glyph, join(glyph.workspace, 'kept.txt'));
    await expect(glyph.composer).toContainText('kept.txt');
    await writeFile(glyph.workspaceTarget, JSON.stringify({ folders: [{ path: glyph.rootPaths[1] }] }));
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Workspace updated: other.' })).toBeVisible();
    await expect(glyph.composer).toContainText('(unavailable)');
    await glyph.sendButton.click();
    await expect(glyph.page.getByText(/Source folder was removed/).first()).toBeVisible();
    expect(provider.requests).toHaveLength(1);
    expect(await read(glyph, provider, 'kept.txt')).toContain('OTHER ROOT CONTENT');
    expect(await read(glyph, provider, 'workspace/kept.txt')).not.toContain('ORIGINAL CAPTURE');
    await expect(glyph.userEntries.first()).toContainText('Remember this conversation');
  });
});

it.describe('work in flight', () => {
  it.use({ additionalRoots: [{ name: 'other', files: {} }] });
  it('cancels an active turn and keeps the queued follow-up paused until explicitly resumed', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Working on the old folders.'], hold: true });
    await glyph.send('Start working');
    await expect(glyph.assistantEntries).toContainText('Working on the old folders.');
    await glyph.composer.fill('Queued follow-up');
    await glyph.composer.press('Enter');
    const queue = glyph.page.getByRole('region', { name: 'Queued messages', exact: true });
    await expect(queue).toContainText('Queued follow-up');
    await glyph.composer.fill('Keep my newer draft');
    await writeFile(glyph.workspaceTarget, JSON.stringify({ folders: [{ path: glyph.rootPaths[1] }] }));
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Workspace updated: other.' })).toBeVisible();
    await expect.poll(() => provider.requests[0].closed).toBe(true);
    await expect(glyph.composer).toHaveText('Keep my newer draft');
    await expect(queue).toContainText('Queued follow-up');
    await expect(queue.getByRole('button', { name: /Resume/ })).toBeVisible();
    expect(provider.requests).toHaveLength(1);
    provider.enqueue({ chunks: ['Explicitly resumed in the updated workspace.'] });
    await queue.getByRole('button', { name: /Resume/ }).click();
    await expect(glyph.assistantEntries.last()).toContainText('Explicitly resumed in the updated workspace.');
    await expect(queue).toHaveCount(0);
    await expect(glyph.composer).toHaveText('Keep my newer draft');
    expect(provider.requests).toHaveLength(2);
  });
});

it.describe('managed processes', () => {
  it.use({ additionalRoots: [{ name: 'other', files: {} }] });
  it('terminates the old workspace background process before reporting the new workspace ready', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'execute_shell',
            {
              command: 'echo $$ > glyph-background.pid; while :; do sleep 1; done',
              terminal_id: null,
              working_directory: 'workspace',
              background: true,
              wake_on: null,
              timeout_ms: 5000,
            },
            { namespace: 'shell', callId: 'background' },
          ),
        ],
      },
      { chunks: ['Background process started.'] },
    );
    await glyph.send('Start the background process.');
    await glyph.page
      .getByRole('region', { name: 'Command approval' })
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await expect.poll(() => provider.requests.length).toBe(2);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.page.getByRole('region', { name: 'Background terminals', exact: true })).toContainText(
      '1 background terminal',
    );
    let pid;
    await expect
      .poll(async () => {
        pid = Number(await readFile(join(glyph.workspace, 'glyph-background.pid'), 'utf8').catch(() => '0'));
        return Number.isSafeInteger(pid) && pid > 1;
      })
      .toBe(true);
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    process.kill(pid, 0);
    await writeFile(glyph.workspaceTarget, JSON.stringify({ folders: [{ path: glyph.rootPaths[1] }] }));
    await expect(glyph.page.getByRole('status').filter({ hasText: 'Workspace updated: other.' })).toBeVisible();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(glyph.page.getByRole('region', { name: 'Background terminals', exact: true })).toHaveCount(0);
    expect(provider.requests).toHaveLength(2);
  });
});
