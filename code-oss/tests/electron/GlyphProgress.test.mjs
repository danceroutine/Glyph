import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const restartsHost = isolatedLaunch('restarts the host and reloads the window');
const read = () =>
  ScriptedProvider.tool('read_project_file', { path: 'progress.txt', start_line: null, end_line: null });
const question = () =>
  ScriptedProvider.tool(
    'propose_question',
    {
      title: null,
      questions: [
        {
          id: 'choice',
          prompt: 'Which option?',
          allow_multiple: false,
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    },
    { namespace: 'interaction', callId: 'question' },
  );

async function expectUsage(glyph, values) {
  const trigger = glyph.page.getByRole('button', { name: 'Conversation token usage', exact: true });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const usage = glyph.page.getByRole('dialog', { name: 'Conversation token usage', exact: true });
  await expect(usage.locator('dt')).toHaveText(['Input', 'Cached input', 'Output', 'Reasoning', 'Total']);
  await expect(usage.locator('dd')).toHaveText(values.map(String));
}

it.describe('Reasoning, tool progress, and conversation usage', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });

  it('renders highlighted fenced code with wrapping, exact clipboard copy, and dates on consecutive replies', async ({
    glyph,
    provider,
  }) => {
    const source =
      'const next = queue.shift();\nif (next) await send("' + 'preserve the original attachments '.repeat(8) + '");';
    provider.enqueue({ chunks: ['```ts\n' + source + '\n```'] }, { chunks: ['A second reply.'] });
    await glyph.send('Show the queue implementation.');
    const block = glyph.assistantEntries.first().locator('.glyph-code-block');
    await expect(block.locator('.hljs-keyword').first()).toHaveText('const');
    await block.getByRole('button', { name: 'Wrap code' }).click();
    await expect(block.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
    await block.getByRole('button', { name: 'Copy code', exact: true }).click();
    await expect(block.getByRole('button', { name: 'Copied code', exact: true })).toBeVisible();
    expect(await glyph.application.evaluate(({ clipboard }) => clipboard.readText())).toBe(source);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.send('And another response.');
    await expect(glyph.assistantEntries.last()).toContainText('A second reply.');
    await glyph.assistantEntries.last().getByRole('button', { name: 'Copy message' }).click();
    expect(await glyph.application.evaluate(({ clipboard }) => clipboard.readText())).toBe('A second reply.');
    await glyph.composer.click();
    for (const entry of await glyph.assistantEntries.all()) {
      await glyph.composer.hover();
      await expect(entry.locator('time')).toHaveCSS('opacity', '0');
      await entry.hover();
      await expect(entry.locator('time')).toHaveCSS('opacity', '1');
    }
    await glyph.page.screenshot({ path: '.artifacts/chat-code-blocks-native.png' });
  });

  it(
    'shows reasoning and tool progress while an answer is running',
    restartsHost,
    async ({ glyph, provider }, testInfo) => {
      await writeFile(join(glyph.workspace, 'progress.txt'), 'Real file contents.');
      provider.enqueue(
        { reasoning: ['Inspecting ', 'the file — café 🌱.'], output: [read()], hold: true },
        { chunks: ['Read the file.'], hold: true },
      );
      await glyph.send('Read progress.txt and explain it.');
      const reasoning = glyph.page.locator('.glyph-reasoning');
      await reasoning.locator('summary').click();
      await expect(reasoning.locator('p')).toHaveText('Inspecting the file — café 🌱.');
      await expect(glyph.sendButton).toHaveText('Cancel');
      provider.release(0);
      const tools = glyph.page.getByRole('list', { name: 'Tool activity' }).getByRole('listitem');
      await expect(tools.locator('summary')).toHaveText(['Read project file']);
      await tools.locator('summary').click();
      await expect(tools.locator('pre')).toContainText('progress.txt');
      await expect(tools.locator('pre')).toContainText('Real file contents.');
      await expect(tools.locator('.glyph-tool-status')).toHaveText('Finished');
      await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['Read the file.']);
      await expect(glyph.sendButton).toHaveText('Cancel');
      await testInfo.attach('reasoning-and-tool-progress', {
        body: await glyph.page.screenshot(),
        contentType: 'image/png',
      });
      provider.release(1);
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      await glyph.crashHost();
      await glyph.reload();
      await expect(tools.locator('summary')).toHaveText(['Read project file']);
      await tools.locator('summary').click();
      await expect(tools.locator('pre')).toContainText('progress.txt');
      await expect(tools.locator('pre')).toContainText('Real file contents.');
      await expect(tools.locator('.glyph-tool-status')).toHaveText('Finished');
      await reasoning.locator('summary').click();
      await expect(reasoning.locator('p')).toHaveText('Inspecting the file — café 🌱.');

      // A real question tool provides a deterministic running operation. This
      // exercises activity/cancellation, not the later question-answering UI.
      provider.enqueue({ output: [question()] });
      await glyph.send('Wait for my choice.');
      await expect(tools.last().locator('summary')).toHaveText('Running propose question');
      await expect(tools.last()).toHaveAttribute('aria-busy', 'true');
      await glyph.sendButton.click();
      await expect(tools.last().locator('summary')).toHaveText('Interrupted · propose question');
      await expect(tools.last()).toHaveAttribute('aria-busy', 'false');
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      provider.enqueue({ output: [question()] });
      await glyph.send('Wait again.');
      await expect(tools.last().locator('summary')).toHaveText('Running propose question');
      await glyph.crashHost();
      await expect(tools.last().locator('summary')).toHaveText('Interrupted · propose question');
      await expect(glyph.page.locator('.glyph-tools [aria-busy="true"]')).toHaveCount(0);
      expect(provider.requests).toHaveLength(4);
    },
  );

  it(
    'bundles consecutive calls and restores expandable arguments and results after reopening a chat',
    restartsHost,
    async ({ glyph, provider }, testInfo) => {
      await writeFile(join(glyph.workspace, 'first.txt'), 'First captured result.');
      await writeFile(join(glyph.workspace, 'second.txt'), 'Second captured result.');
      provider.enqueue(
        {
          output: ['first', 'second'].map(id =>
            ScriptedProvider.tool(
              'read_project_file',
              { path: `${id}.txt`, start_line: null, end_line: null },
              { callId: id },
            ),
          ),
        },
        { chunks: ['Both files have been read.'] },
      );
      await glyph.send('Read first.txt and second.txt.');
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      const group = glyph.page.locator('.glyph-tool-group');
      await expect(group.locator(':scope > summary')).toHaveText('Explored2 tools');
      await expect(group.getByRole('list', { name: 'Tool activity' })).toBeHidden();
      await group.locator(':scope > summary').click();
      const row = group.locator('[data-tool-id="second"]');
      await row.locator('summary').click();
      await expect(row.locator('pre')).toContainText('second.txt');
      await expect(row.locator('pre')).toContainText('Second captured result.');
      await testInfo.attach('expanded-tool-group', { body: await glyph.page.screenshot(), contentType: 'image/png' });
      await glyph.crashHost();
      await glyph.reload();
      await group.locator(':scope > summary').click();
      await row.locator('summary').click();
      await expect(row.locator('pre')).toContainText('second.txt');
      await expect(row.locator('pre')).toContainText('Second captured result.');
    },
  );

  it(
    'shows input, cached input, output, reasoning, and total token usage for the selected conversation',
    restartsHost,
    async ({ glyph, provider }) => {
      provider.enqueue({
        chunks: ['Counted answer.'],
        usage: { input: 100, cached: 40, output: 30, reasoning: 12, total: 130 },
      });
      await glyph.send('Show the reported usage.');
      await expect(glyph.userEntries).toContainText('Show the reported usage.');
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      const turnUsage = glyph.assistantEntries.last().getByRole('button', { name: 'Turn token usage' });
      await turnUsage.click();
      await expect(glyph.page.getByRole('dialog', { name: 'Turn token usage' }).locator('dd')).toHaveText([
        '100',
        '40',
        '30',
        '12',
        '130',
      ]);
      await glyph.page.keyboard.press('Escape');
      await glyph.assistantEntries.last().hover();
      await expect(glyph.assistantEntries.last().locator('time')).toHaveCSS('opacity', '1');
      await expectUsage(glyph, [100, 40, 30, 12, 130]);
      provider.enqueue({ chunks: ['No usage report.'], usage: null });
      await glyph.send('Finish without a usage report.');
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      await expectUsage(glyph, [100, 40, 30, 12, 130]);
      await expect(
        glyph.page.getByRole('dialog', { name: 'Conversation token usage' }).getByRole('status'),
      ).toContainText('Usage missing or incomplete for 1 completed turn.');
      await glyph.crashHost();
      await glyph.reload();
      await expectUsage(glyph, [100, 40, 30, 12, 130]);
      await expect(
        glyph.page.getByRole('dialog', { name: 'Conversation token usage' }).getByRole('status'),
      ).toContainText('Usage missing or incomplete for 1 completed turn.');
    },
  );

  it(
    'updates usage after a turn and restores the same totals after reconnecting without double-counting',
    restartsHost,
    async ({ glyph, provider }, testInfo) => {
      await writeFile(join(glyph.workspace, 'progress.txt'), 'Usage fixture.');
      provider.enqueue(
        { output: [read()], usage: { input: 100, cached: 20, output: 10, reasoning: 3, total: 110 } },
        { chunks: ['First answer.'], usage: { input: 150, cached: 80, output: 30, reasoning: 5, total: 180 } },
        {
          chunks: ['Second answer.'],
          usage: { input: 200, cached: 110, output: 50, reasoning: 7, total: 250 },
          hold: true,
        },
      );
      await glyph.send('Read progress.txt.');
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      await expectUsage(glyph, [250, 100, 40, 8, 290]);
      await glyph.send('Continue.');
      await expect(glyph.assistantEntries.last()).toContainText('Second answer.');
      await expectUsage(glyph, [250, 100, 40, 8, 290]);
      provider.release(2);
      await expect(glyph.sendButton).toHaveText('Send (Enter)');
      await expectUsage(glyph, [450, 210, 90, 15, 540]);
      await glyph.reload();
      await expectUsage(glyph, [450, 210, 90, 15, 540]);
      await glyph.crashHost();
      await glyph.reload();
      await expectUsage(glyph, [450, 210, 90, 15, 540]);
      await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
        'First answer.',
        'Second answer.',
      ]);
      expect(provider.requests).toHaveLength(3);
      await testInfo.attach('restored-conversation-usage', {
        body: await glyph.page.screenshot(),
        contentType: 'image/png',
      });
    },
  );
});

it.describe('Rich Markdown in the native chat', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });
  it('submits formatted lists and quotes, then renders Markdown and a Mermaid response', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue({
      chunks: [
        '## Verified\n\n**Lists** and `quotes` render here.\n\n```mermaid\nflowchart LR\n  A[Draft] --> B[Send]\n```',
      ],
    });
    await glyph.composer.pressSequentially('1. First');
    await glyph.composer.press('Shift+Enter');
    await glyph.composer.pressSequentially('Second');
    await glyph.composer.press('Shift+Enter');
    await glyph.composer.press('Shift+Enter');
    await glyph.composer.pressSequentially('> Keep **revisions**');
    await expect(glyph.composer.locator('ol > li')).toHaveCount(2);
    await expect(glyph.composer.locator('blockquote strong')).toHaveText('revisions');
    await glyph.sendButton.click();
    await expect(glyph.assistantEntries.getByRole('heading', { name: 'Verified' })).toBeVisible();
    await expect(glyph.assistantEntries.getByRole('img', { name: 'Plan diagram' })).toBeVisible();
    await expect(glyph.userEntries.locator('ol > li')).toHaveCount(2);
    await expect(glyph.userEntries.locator('blockquote strong')).toHaveText('revisions');
    expect(JSON.stringify(provider.requests[0].body)).toContain('1. First\\n2. Second');
    await testInfo.attach('native-markdown-chat', { body: await glyph.page.screenshot(), contentType: 'image/png' });
  });
});
