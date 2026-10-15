import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

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
  const usage = glyph.page.getByLabel('Conversation token usage', { exact: true });
  if (!(await usage.evaluate(element => element.open))) await usage.locator('summary').click();
  await expect(usage.locator('dt')).toHaveText(['Input', 'Cached input', 'Output', 'Reasoning', 'Total']);
  await expect(usage.locator('dd')).toHaveText(values.map(String));
}

it.describe('Reasoning, tool progress, and conversation usage', () => {
  it.use({ scriptedProvider: true });

  it('shows reasoning and tool progress while an answer is running', async ({ glyph, provider }, testInfo) => {
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
    await expect(tools).toHaveText(['read_project_fileFinished']);
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['Read the file.']);
    await expect(glyph.sendButton).toHaveText('Cancel');
    await testInfo.attach('reasoning-and-tool-progress', {
      body: await glyph.page.screenshot(),
      contentType: 'image/png',
    });
    provider.release(1);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await glyph.crashHost();
    await glyph.reload();
    await expect(tools).toHaveText(['read_project_fileFinished']);
    await reasoning.locator('summary').click();
    await expect(reasoning.locator('p')).toHaveText('Inspecting the file — café 🌱.');

    // A real question tool provides a deterministic running operation. This
    // exercises activity/cancellation, not the later question-answering UI.
    provider.enqueue({ output: [question()] });
    await glyph.send('Wait for my choice.');
    await expect(tools.last()).toHaveText('propose_questionRunning');
    await expect(tools.last()).toHaveAttribute('aria-busy', 'true');
    await glyph.sendButton.click();
    await expect(tools.last()).toHaveText('propose_questionInterrupted');
    await expect(tools.last()).toHaveAttribute('aria-busy', 'false');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    provider.enqueue({ output: [question()] });
    await glyph.send('Wait again.');
    await expect(tools.last()).toHaveText('propose_questionRunning');
    await glyph.crashHost();
    await expect(tools.last()).toHaveText('propose_questionInterrupted');
    await expect(glyph.page.locator('.glyph-tools [aria-busy="true"]')).toHaveCount(0);
    expect(provider.requests).toHaveLength(4);
  });

  it('shows input, cached input, output, reasoning, and total token usage for the selected conversation', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({
      chunks: ['Counted answer.'],
      usage: { input: 100, cached: 40, output: 30, reasoning: 12, total: 130 },
    });
    await glyph.send('Show the reported usage.');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expectUsage(glyph, [100, 40, 30, 12, 130]);
    provider.enqueue({ chunks: ['No usage report.'], usage: null });
    await glyph.send('Finish without a usage report.');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expectUsage(glyph, [100, 40, 30, 12, 130]);
    await expect(glyph.page.locator('.glyph-usage [role="status"]')).toContainText(
      'Usage missing or incomplete for 1 completed turn.',
    );
    await glyph.crashHost();
    await glyph.reload();
    await expectUsage(glyph, [100, 40, 30, 12, 130]);
    await expect(glyph.page.locator('.glyph-usage [role="status"]')).toContainText(
      'Usage missing or incomplete for 1 completed turn.',
    );
  });

  it('updates usage after a turn and restores the same totals after reconnecting without double-counting', async ({
    glyph,
    provider,
  }, testInfo) => {
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
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expectUsage(glyph, [250, 100, 40, 8, 290]);
    await glyph.send('Continue.');
    await expect(glyph.assistantEntries.last()).toContainText('Second answer.');
    await expectUsage(glyph, [250, 100, 40, 8, 290]);
    provider.release(2);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expectUsage(glyph, [450, 210, 90, 15, 540]);
    await glyph.reload();
    await expectUsage(glyph, [450, 210, 90, 15, 540]);
    await glyph.crashHost();
    await glyph.reload();
    await expectUsage(glyph, [450, 210, 90, 15, 540]);
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['First answer.', 'Second answer.']);
    expect(provider.requests).toHaveLength(3);
    await testInfo.attach('restored-conversation-usage', {
      body: await glyph.page.screenshot(),
      contentType: 'image/png',
    });
  });
});
