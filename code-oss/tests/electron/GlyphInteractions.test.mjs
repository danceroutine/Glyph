import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const language = {
  id: 'language',
  prompt: 'Which language?',
  allow_multiple: false,
  options: [
    { id: 'ts', label: 'TypeScript' },
    { id: 'rust', label: 'Rust' },
  ],
};
const question = (questions = [language], callId = 'question') =>
  ScriptedProvider.tool('propose_question', { title: 'Questions', questions }, { namespace: 'interaction', callId });
const command = 'printf approved >> approval-proof.txt';
const shell = (workingDirectory = null, callId = 'shell') =>
  ScriptedProvider.tool(
    'execute_shell',
    {
      command,
      terminal_id: null,
      working_directory: workingDirectory,
      background: false,
      wake_on: null,
      timeout_ms: 5000,
    },
    { namespace: 'shell', callId },
  );
const form = glyph => glyph.page.getByRole('form', { name: 'Questions' });
const approval = glyph => glyph.page.getByRole('region', { name: 'Command approval' });
const proof = (glyph, path = 'approval-proof.txt') =>
  readFile(join(glyph.workspace, path), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
const outputs = (provider, callId) =>
  provider.requests
    .at(-1)
    .body.input.filter(item => item.type === 'function_call_output' && item.call_id === callId)
    .map(item => JSON.parse(item.output));
const finished = glyph => expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');

it.describe('Questions and command approvals', () => {
  it.use({ scriptedProvider: true, workspaceFiles: { 'nested/.keep': '' } });

  it('renders a host question as an accessible answer form with a submit control connected to the waiting run', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue({ output: [question()] });
    await glyph.send('Ask which language I prefer.');
    await expect(form(glyph).getByRole('group', { name: '1. Which language?' })).toBeVisible();
    await expect(form(glyph).getByRole('radio')).toHaveCount(3);
    await expect(form(glyph).getByRole('radio', { name: 'TypeScript', exact: true })).not.toBeChecked();
    await expect(form(glyph).getByRole('button', { name: 'Continue' })).toBeDisabled();
    await testInfo.attach('question-card', {
      body: await glyph.page.screenshot({ path: testInfo.outputPath('decision-card.png') }),
      contentType: 'image/png',
    });
    await form(glyph).getByRole('button', { name: 'Cancel turn' }).click();
    await finished(glyph);
  });

  it('renders a host approval with the requested operation and separate allow and deny controls connected to the waiting run', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue({ output: [shell()] });
    await glyph.send('Write the approval proof.');
    await expect(approval(glyph).locator('pre')).toHaveText(command);
    await expect(approval(glyph)).toContainText(glyph.workspace);
    await expect(approval(glyph).getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    await expect(approval(glyph).getByRole('button', { name: 'Skip', exact: true })).toBeEnabled();
    expect(await proof(glyph)).toBeNull();
    await testInfo.attach('approval-card', {
      body: await glyph.page.screenshot({ path: testInfo.outputPath('decision-card.png') }),
      contentType: 'image/png',
    });
    await glyph.sendButton.click();
    await finished(glyph);
    await expect(approval(glyph)).toHaveCount(0);
    expect(await proof(glyph)).toBeNull();
  });

  it('resumes a waiting answer after the user answers its question', async ({ glyph, provider }) => {
    provider.enqueue({ output: [question()] });
    await glyph.send('Ask which language I prefer.');
    await form(glyph).getByRole('radio', { name: 'Rust', exact: true }).check();
    provider.enqueue({ chunks: ['Rust it is.'] });
    await form(glyph).getByRole('button', { name: 'Continue' }).click();
    await finished(glyph);
    await expect(glyph.assistantEntries.last()).toContainText('Rust it is.');
    await expect(form(glyph)).toHaveCount(0);
    expect(outputs(provider, 'question')).toEqual([{ answers: { language: 'rust' } }]);
  });

  it('runs a requested operation only after the user approves it', async ({ glyph, provider }) => {
    provider.enqueue({ output: [shell()] });
    await glyph.send('Write the approval proof.');
    await expect(approval(glyph)).toBeVisible();
    expect(await proof(glyph)).toBeNull();
    provider.enqueue({ chunks: ['The command finished.'] });
    await approval(glyph).getByRole('button', { name: 'Run', exact: true }).click();
    await finished(glyph);
    expect(await proof(glyph)).toBe('approved');
    expect(outputs(provider, 'shell')).toEqual([expect.objectContaining({ exit_code: 0 })]);
    await expect(approval(glyph)).toHaveCount(0);
    // Run authorizes only this invocation, even for an identical later command.
    provider.enqueue({ output: [shell(null, 'again')] });
    await glyph.send('Write it again.');
    await expect(approval(glyph)).toBeVisible();
    expect(await proof(glyph)).toBe('approved');
    await glyph.sendButton.click();
    await finished(glyph);
  });

  it('continues safely when the user declines an approval request', async ({ glyph, provider }) => {
    provider.enqueue({ output: [shell()] });
    await glyph.send('Write the approval proof.');
    await expect(approval(glyph)).toBeVisible();
    provider.enqueue({ chunks: ['The command was declined. I can continue without it.'] });
    await approval(glyph).getByRole('button', { name: 'Skip', exact: true }).click();
    await finished(glyph);
    expect(await proof(glyph)).toBeNull();
    expect(outputs(provider, 'shell')).toHaveLength(1);
    expect(JSON.stringify(outputs(provider, 'shell'))).toMatch(/denied/i);
    await expect(glyph.assistantEntries.last()).toContainText('The command was declined.');
  });

  it('shows the proposed questions and choices and waits for the user before continuing the answer', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ output: [question()] });
    await glyph.send('Ask which language I prefer.');
    await expect(form(glyph)).toBeVisible();
    await glyph.composer.fill('Keep this as my next message.');
    await glyph.composer.press('ControlOrMeta+Enter');
    await expect(form(glyph)).toBeVisible();
    expect(provider.requests).toHaveLength(1);
    await expect(glyph.composer).toHaveText('Keep this as my next message.');
    await form(glyph).getByRole('button', { name: 'Cancel turn' }).click();
    await finished(glyph);
  });

  it('returns selected choices and Other free-text answers to the requesting run exactly once', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({
      output: [
        question([
          language,
          {
            ...language,
            id: 'priorities',
            prompt: 'Which priorities?',
            allow_multiple: true,
            options: [
              { id: 'clarity', label: 'Clarity' },
              { id: 'speed', label: 'Speed' },
            ],
          },
          { ...language, id: 'notes', prompt: 'Anything else?' },
        ]),
      ],
    });
    await glyph.send('Ask me three questions.');
    await form(glyph).getByRole('radio', { name: 'Rust', exact: true }).check();
    await form(glyph).getByRole('button', { name: 'Continue' }).click();
    await form(glyph).getByRole('checkbox', { name: 'Clarity', exact: true }).check();
    await form(glyph).getByRole('checkbox', { name: 'Speed', exact: true }).check();
    await form(glyph).getByRole('button', { name: 'Continue' }).click();
    await form(glyph).getByRole('radio', { name: 'Other…', exact: true }).check();
    await form(glyph).getByRole('textbox', { name: 'Your answer' }).fill('Custom answer — café 🌱');
    provider.enqueue({ chunks: ['All three answers received.'] });
    // Two same-tick submissions exercise the guard before the DOM disables.
    await form(glyph).evaluate(element => {
      element.requestSubmit();
      element.requestSubmit();
    });
    await finished(glyph);
    expect(outputs(provider, 'question')).toEqual([
      { answers: { language: 'rust', priorities: ['clarity', 'speed'], notes: 'Custom answer — café 🌱' } },
    ]);
    expect(provider.requests).toHaveLength(2);
  });

  it('cancels a waiting question with its run and rejects a late answer instead of reviving the cancelled run', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ output: [question()] });
    await glyph.send('Ask which language I prefer.');
    await form(glyph).getByRole('radio', { name: 'Rust', exact: true }).check();
    const staleForm = await form(glyph).elementHandle();
    await form(glyph).getByRole('button', { name: 'Cancel turn' }).click();
    await finished(glyph);
    await expect(form(glyph)).toHaveCount(0);
    await staleForm.evaluate(element =>
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    provider.enqueue({ chunks: ['A fresh turn works.'] });
    await glyph.send('Start a fresh turn.');
    await finished(glyph);
    await expect(glyph.assistantEntries.last()).toContainText('A fresh turn works.');
    expect(provider.requests).toHaveLength(2);
  });

  it('remembers an exact command across host restarts while requiring approval in another directory', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ output: [shell()] });
    await glyph.send('Remember this command.');
    await expect(approval(glyph)).toBeVisible();
    provider.enqueue({ chunks: ['Remembered.'] });
    await approval(glyph).getByRole('button', { name: 'Always Run', exact: true }).click();
    await finished(glyph);
    expect(await proof(glyph)).toBe('approved');
    await glyph.crashHost();
    await glyph.reload();
    provider.enqueue({ output: [shell(null, 'remembered')] }, { chunks: ['Ran the remembered command.'] });
    await glyph.send('Run the exact command again.');
    await finished(glyph);
    expect(await proof(glyph)).toBe('approvedapproved');
    provider.enqueue({ output: [shell('nested', 'different-directory')] });
    await glyph.send('Run it in nested instead.');
    await expect(approval(glyph)).toBeVisible();
    await expect(approval(glyph)).toContainText(join(glyph.workspace, 'nested'));
    provider.enqueue({ chunks: ['Declined in the other directory.'] });
    await approval(glyph).getByRole('button', { name: 'Skip', exact: true }).click();
    await finished(glyph);
    expect(await proof(glyph, 'nested/approval-proof.txt')).toBeNull();
  });

  it('advances queued question forms without replaying answers', async ({ glyph, provider }) => {
    provider.enqueue({
      output: [question([language], 'first'), question([{ ...language, prompt: 'Choose again.' }], 'second')],
    });
    await glyph.send('Ask two separate forms.');
    await expect(form(glyph)).toContainText('Which language?');
    await form(glyph).getByRole('radio', { name: 'Rust', exact: true }).check();
    await form(glyph).getByRole('button', { name: 'Continue' }).click();
    await expect(form(glyph)).toContainText('Choose again.');
    await form(glyph).getByRole('radio', { name: 'TypeScript', exact: true }).check();
    provider.enqueue({ chunks: ['Both forms received.'] });
    await form(glyph).getByRole('button', { name: 'Continue' }).click();
    await finished(glyph);
    expect(outputs(provider, 'first')).toEqual([{ answers: { language: 'rust' } }]);
    expect(outputs(provider, 'second')).toEqual([{ answers: { language: 'ts' } }]);
    expect(provider.requests).toHaveLength(2);
  });
  it('removes interrupted question and approval controls after reload or host failure', async ({ glyph, provider }) => {
    provider.enqueue({ output: [question()] });
    await glyph.send('Wait for an answer.');
    await expect(form(glyph)).toBeVisible();
    await glyph.reload();
    await expect(form(glyph)).toHaveCount(0);
    await finished(glyph);
    provider.enqueue({ output: [shell()] });
    await glyph.send('Wait for approval.');
    await expect(approval(glyph)).toBeVisible();
    await glyph.crashHost();
    await expect(approval(glyph)).toHaveCount(0);
    await finished(glyph);
    expect(await proof(glyph)).toBeNull();
    await glyph.reload();
    await expect(approval(glyph)).toHaveCount(0);
    expect(provider.requests).toHaveLength(2);
  });
});
