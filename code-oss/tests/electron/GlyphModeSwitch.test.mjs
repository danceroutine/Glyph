import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';
async function planMode(glyph) {
  await glyph.page.getByRole('combobox', { name: 'Conversation mode' }).click();
  await glyph.page.getByRole('option', { name: 'Plan', exact: true }).click();
}
const swap = (target = 'agent') =>
  ScriptedProvider.tool(
    'request_mode_switch',
    { target, description: 'The plan is ready. Switch modes to implement and verify it.' },
    { namespace: 'interaction', callId: `switch-${target}` },
  );
const patch = (path, callId) =>
  ScriptedProvider.tool('propose_patch', `*** Begin Patch\n*** Add File: ${path}\n+# Plan\n*** End Patch`, {
    callId,
    inputKind: 'text',
  });
it.describe('Mode switches', () => {
  it.use({ scriptedProvider: true });
  it('switches only on approval and restores the announcement from durable history', async ({ glyph, provider }) => {
    await planMode(glyph);
    provider.enqueue({ output: [swap()] }, { chunks: ['Implementation can now begin.'] });
    await glyph.send('Request Agent mode to implement this plan.');
    const card = glyph.page.getByRole('region', { name: 'Mode switch' });
    await expect(card).toContainText('Switch to Agent Mode');
    await expect(card.getByRole('progressbar', { name: 'Automatic denial countdown' })).toBeVisible();
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card).toContainText('Switched to Agent Mode');
    await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toContainText('Agent');
    await expect(glyph.page.getByText('Implementation can now begin.', { exact: true })).toBeVisible();
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.crashHost();
    await glyph.reload();
    await expect(card).toContainText('Switched to Agent Mode');
    await expect(card.getByRole('button')).toHaveCount(0);
    await glyph.page.screenshot({ path: '.artifacts/mode-switch-native-approved.png' });
  });
  it('denies manually, retains Plan mode, and blocks a follow-up code edit', async ({ glyph, provider }) => {
    await planMode(glyph);
    provider.enqueue(
      { output: [swap()] },
      { output: [patch('should-not-exist.ts', 'blocked')] },
      { chunks: ['Stayed in Plan mode.'] },
    );
    await glyph.send('Ask to switch, then try a code edit.');
    const card = glyph.page.getByRole('region', { name: 'Mode switch' });
    await expect(card).toContainText('Switch to Agent Mode');
    await glyph.page.screenshot({ path: '.artifacts/mode-switch-native-pending.png' });
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(card).toContainText('Switch to Agent Mode denied');
    await expect(glyph.page.getByText('Stayed in Plan mode.', { exact: true })).toBeVisible();
    await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toContainText('Plan');
    expect(JSON.stringify(provider.requests)).toContain('Plan Mode can only edit Markdown');
    await expect(glyph.page.locator('.glyph-pending-reviews')).toHaveCount(0);
  });
  it('applies Plan restrictions immediately after switching from Agent, allowing only Markdown proposals', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue(
      { output: [swap('plan')] },
      { output: [patch('plan.md', 'markdown'), patch('implementation.ts', 'code')] },
      { chunks: ['The Markdown plan is ready for review; code edits are blocked.'] },
    );
    await glyph.send('Switch to planning and propose both Markdown and code changes.');
    const card = glyph.page.getByRole('region', { name: 'Mode switch' });
    await expect(card).toContainText('Switch to Plan Mode');
    await card.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card).toContainText('Switched to Plan Mode');
    await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toContainText('Plan');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    const results = provider.requests.at(-1).body.input.filter(item => item.type === 'custom_tool_call_output');
    expect(JSON.parse(results.find(item => item.call_id === 'markdown').output).status).toBe('APPLIED_WITH_REVERT');
    expect(JSON.parse(results.find(item => item.call_id === 'code').output).error.message).toContain(
      'only edit Markdown',
    );
    await expect(glyph.page.getByRole('region', { name: 'Pending reviews' })).toContainText('1 File');
    await expect(glyph.page.getByRole('region', { name: 'Pending reviews' })).not.toContainText('implementation.ts');
  });
  it.describe('Countdown', () => {
    it.use({ userSettings: { 'glyph.modeSwitch.timeoutSeconds': 5 } });
    it('automatically denies by default', async ({ glyph, provider }) => {
      await planMode(glyph);
      provider.enqueue({ output: [swap()] }, { chunks: ['The timer declined the request.'] });
      await glyph.send('Request a mode switch.');
      const card = glyph.page.getByRole('region', { name: 'Mode switch' });
      await expect(card.getByRole('progressbar', { name: 'Automatic denial countdown' })).toBeVisible();
      await expect(card).toContainText('Switch to Agent Mode denied');
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toContainText('Plan');
    });
  });
  it.describe('Auto approve enabled', () => {
    it.use({ userSettings: { 'glyph.modeSwitch.timeoutSeconds': 5, 'glyph.modeSwitch.autoApprove': true } });
    it('automatically switches with the user setting enabled', async ({ glyph, provider }) => {
      await planMode(glyph);
      provider.enqueue({ output: [swap()] }, { chunks: ['The timer approved the switch.'] });
      await glyph.send('Request a mode switch.');
      const card = glyph.page.getByRole('region', { name: 'Mode switch' });
      await expect(card.getByRole('progressbar', { name: 'Automatic approval countdown' })).toBeVisible();
      await expect(card).toContainText('Switched to Agent Mode');
      await expect(glyph.page.getByRole('combobox', { name: 'Conversation mode' })).toContainText('Agent');
    });
  });
});
