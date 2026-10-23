import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';
import { parseJson } from './ProviderPayloads.mjs';

/** @param {import('./GlyphWorkbench.mjs').GlyphWorkbench} glyph */
const row = glyph => glyph.page.getByRole('region', { name: 'Goal', exact: true });
/** @param {string} callId */
const completeGoal = callId =>
  ScriptedProvider.tool('update_goal', { status: 'complete' }, { namespace: 'goal', callId });
/** @param {ScriptedProvider} provider @param {string} callId */
const toolOutput = (provider, callId) =>
  parseJson(
    provider.requests
      .flatMap(request => request.body.input)
      .find(value => value.type === 'function_call_output' && value.call_id === callId)?.output,
  );

it.describe('Durable goals', () => {
  it.use({ scriptedProvider: true });

  it('keeps working toward a /goal objective until the agent marks it complete', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'update_todos',
            { items: [{ id: 'ci', text: 'Fix the failing suite', status: 'in_progress' }], replace: true },
            { namespace: 'todo', callId: 'todo' },
          ),
        ],
      },
      { chunks: ['Fixed the first failure.'] },
      { output: [completeGoal('finish')] },
      { chunks: ['CI is green.'] },
    );

    await glyph.send('/goal Make CI green');

    await expect(row(glyph)).toContainText('Make CI green');
    await expect.poll(() => provider.requests.length).toBe(4);
    await expect(row(glyph)).toContainText('Complete');
    await testInfo.attach('completed-goal', {
      body: await glyph.page.screenshot({ path: testInfo.outputPath('completed-goal.png') }),
      contentType: 'image/png',
    });
    expect(provider.requests[0].body.instructions).toContain('## Goals');
    expect(provider.requests[0].body.input).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringMatching(/"type":"goal_continuation".*"objective":"Make CI green"/u),
      }),
    );
    expect(toolOutput(provider, 'finish')).toMatchObject({ goal: { objective: 'Make CI green', status: 'complete' } });
    await expect(glyph.page.getByText('Continue working toward the active goal.')).toHaveCount(2);
    await expect(glyph.composer).toHaveText('');
    await glyph.page.waitForTimeout(1000);
    expect(provider.requests).toHaveLength(4);
  });

  it('pauses a goal that stops making progress, keeps it across reload, and resumes or clears it', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Looking.'] }, { chunks: ['Still looking.'] }, { chunks: ['Nothing to do.'] });

    await glyph.send('/goal Make CI green');

    await expect.poll(() => provider.requests.length).toBe(3);
    await expect(row(glyph)).toContainText('Paused · No progress');
    await glyph.reload();
    await expect(row(glyph)).toContainText('Paused · No progress');
    await glyph.page.waitForTimeout(1000);
    expect(provider.requests).toHaveLength(3);

    provider.enqueue({ output: [completeGoal('finish')] }, { chunks: ['CI is green.'] });
    await row(glyph).getByRole('button', { name: 'Resume goal' }).click();

    await expect.poll(() => provider.requests.length).toBe(5);
    await expect(row(glyph)).toContainText('Complete');
    await row(glyph).getByRole('button', { name: 'Clear goal' }).click();
    await expect(row(glyph)).toHaveCount(0);
    await glyph.reload();
    await expect(glyph.composer).toBeVisible();
    await expect(row(glyph)).toHaveCount(0);
  });

  it('pauses the goal when the human stops a continuation and restarts only after Resume', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Working'], hold: true });

    await glyph.send('/goal Make CI green');
    await expect.poll(() => provider.requests.length).toBe(1);
    await glyph.sendButton.click();

    await expect(row(glyph)).toContainText('Paused · Stopped');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.page.waitForTimeout(1000);
    expect(provider.requests).toHaveLength(1);

    provider.enqueue({ output: [completeGoal('resumed-finish')] }, { chunks: ['Finished after resuming.'] });
    await row(glyph).getByRole('button', { name: 'Resume goal' }).click();
    await expect.poll(() => provider.requests.length).toBe(3);
    await expect(row(glyph)).toContainText('Complete');
  });

  it('arms an agent-proposed goal only after the human approves it', async ({ glyph, provider }) => {
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool(
            'create_goal',
            { objective: 'Make CI green' },
            { namespace: 'goal', callId: 'propose' },
          ),
        ],
      },
      { chunks: ['Goal armed.'] },
      { output: [completeGoal('finish')] },
      { chunks: ['CI is green.'] },
    );

    await glyph.send('Keep going until CI is green.');

    const approval = glyph.page.getByRole('region', { name: 'Goal approval' });
    await expect(approval).toContainText('Make CI green');
    await expect(row(glyph)).toHaveCount(0);
    await approval.getByRole('button', { name: 'Start goal' }).click();

    await expect.poll(() => provider.requests.length).toBe(4);
    await expect(row(glyph)).toContainText('Complete');
    expect(toolOutput(provider, 'propose')).toMatchObject({
      approved: true,
      goal: { objective: 'Make CI green', status: 'active' },
    });
  });
});
