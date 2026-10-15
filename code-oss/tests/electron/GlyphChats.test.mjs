import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

async function history(glyph) {
  const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return glyph.page.getByRole('navigation', { name: 'Saved chats' });
}

async function closeHistory(glyph) {
  const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
}

async function openChat(glyph, name) {
  const list = await history(glyph);
  await glyph.page.getByRole('searchbox', { name: 'Search chats' }).fill(name);
  await list.getByRole('button').filter({ hasText: name }).click();
  await closeHistory(glyph);
}

it.describe('Saved chats and new conversation setup', () => {
  it.use({ scriptedProvider: true });

  it('shows saved chats and opens the selected chat with its conversation history', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue(
      {
        chunks: ['The alpha answer.'],
        reasoning: ['Alpha reasoning.'],
        usage: { input: 10, cached: 2, output: 4, reasoning: 1, total: 14 },
      },
      { chunks: ['The beta answer.'], usage: { input: 20, cached: 5, output: 7, reasoning: 2, total: 27 } },
    );
    await glyph.send('Alpha project');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await glyph.composer.fill('Unsent alpha draft');
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(glyph.composer).toHaveValue('');
    await glyph.send('Beta project');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await glyph.composer.fill('Unsent beta draft');
    const list = await history(glyph);
    await expect(list.getByRole('button')).toHaveCount(2);
    await expect(list.getByRole('button').first()).toContainText('Beta Project');
    const search = glyph.page.getByRole('searchbox', { name: 'Search chats' });
    await search.fill('No such conversation');
    await expect(list).toContainText('No matching chats.');
    await search.fill('Alpha');
    await expect(list.getByRole('button')).toHaveCount(1);
    await list.getByRole('button').click();
    await closeHistory(glyph);
    await expect(glyph.composer).toHaveValue('Unsent alpha draft');
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['The alpha answer.']);
    await expect(glyph.page.locator('.glyph-usage summary')).toHaveText('14 reported tokens');
    await glyph.page.locator('.glyph-reasoning summary').click();
    await expect(glyph.page.locator('.glyph-reasoning p')).toHaveText('Alpha reasoning.');
    await openChat(glyph, 'Beta');
    await expect(glyph.composer).toHaveValue('Unsent beta draft');
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['The beta answer.']);
    await expect(glyph.page.locator('.glyph-usage summary')).toHaveText('27 reported tokens');
    await openChat(glyph, 'Alpha');
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['The alpha answer.']);
    await glyph.crashHost();
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['The alpha answer.']);
    await expect(glyph.page.locator('.glyph-usage summary')).toHaveText('14 reported tokens');
    await history(glyph);
    const panel = await glyph.page.locator('.part.auxiliarybar').boundingBox();
    const sashes = await glyph.page.locator('.monaco-sash.vertical').all();
    const candidates = (await Promise.all(sashes.map(sash => sash.boundingBox()))).filter(Boolean);
    const sash = candidates.sort(
      (a, b) => Math.abs(a.x + a.width / 2 - panel.x) - Math.abs(b.x + b.width / 2 - panel.x),
    )[0];
    await glyph.page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
    await glyph.page.mouse.down();
    await glyph.page.mouse.move(sash.x + sash.width / 2 - 500, sash.y + sash.height / 2, { steps: 12 });
    await glyph.page.mouse.up();
    await expect(glyph.page.locator('.glyph-chat-history')).toHaveCSS('position', 'static');
    await testInfo.attach('saved-chat-history', { body: await glyph.page.screenshot(), contentType: 'image/png' });
    expect(provider.requests).toHaveLength(2);
  });

  it('keeps a running chat and its draft independent while another conversation is selected', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue({ chunks: ['Alpha still running.'], hold: true }, { chunks: ['Beta finished.'] });
    await glyph.send('Alpha running');
    await expect(glyph.assistantEntries).toContainText(['Alpha still running.']);
    await glyph.composer.fill('Alpha next prompt');
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await glyph.send('Beta completed');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['Beta finished.']);
    provider.release(0);
    await expect.poll(() => provider.requests[0].completed).toBe(true);
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['Beta finished.']);
    await openChat(glyph, 'Alpha');
    await expect(glyph.composer).toHaveValue('Alpha next prompt');
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['Alpha still running.']);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
  });
});

it.describe('Account and model selection', () => {
  it.use({
    scriptedProvider: true,
    scriptedAccounts: [
      [
        {
          subject: 'personal',
          email: 'personal@example.invalid',
          token: 'fixture-personal-token',
          models: [{ slug: 'personal-model', name: 'Personal model' }],
        },
        {
          subject: 'work',
          email: 'work@example.invalid',
          token: 'fixture-work-token',
          models: [
            { slug: 'work-fast', name: 'Work fast' },
            { slug: 'work-deep', name: 'Work deep' },
          ],
        },
        { subject: 'empty', email: 'empty@example.invalid', token: 'fixture-empty-token', models: [] },
      ],
      { scope: 'test' },
    ],
  });

  it('lets the user choose a connected account and model before starting a new chat', async ({
    glyph,
    provider,
  }, testInfo) => {
    await history(glyph);
    const account = glyph.page.getByRole('combobox', { name: 'Account', exact: true });
    await account.selectOption({ label: 'work@example.invalid' });
    await closeHistory(glyph);
    const model = glyph.page.getByRole('combobox', { name: 'Model', exact: true });
    await expect(model).toBeEnabled();
    await model.selectOption('work-deep');
    await glyph.composer.fill('Work analysis');
    await history(glyph);
    await testInfo.attach('account-footer', { body: await glyph.page.screenshot(), contentType: 'image/png' });
    await closeHistory(glyph);
    provider.enqueue({ chunks: ['Work answer.'] });
    await glyph.sendButton.click();
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    expect(provider.requests[0]).toMatchObject({ account: 'work', body: { model: 'work-deep' } });
    await expect(model).toBeDisabled();
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await history(glyph);
    await account.selectOption({ label: 'personal@example.invalid' });
    await closeHistory(glyph);
    await expect(model).toHaveValue('personal-model');
    provider.enqueue({ chunks: ['Personal answer.'] });
    await glyph.send('Personal analysis');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    expect(provider.requests[1]).toMatchObject({ account: 'personal', body: { model: 'personal-model' } });
    await openChat(glyph, 'Work');
    await expect(model).toHaveValue('work-deep');
    await history(glyph);
    await expect(account.locator('option:checked')).toHaveText('work@example.invalid');
    await expect(account).toBeDisabled();
    await closeHistory(glyph);
    await glyph.crashHost();
    await glyph.reload();
    provider.enqueue({ chunks: ['Work continued.'] });
    await glyph.send('Continue the work conversation');
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    expect(provider.requests[2]).toMatchObject({ account: 'work', body: { model: 'work-deep' } });
    expect(JSON.stringify(provider.requests[2].body.input)).toContain('Work analysis');
    expect(JSON.stringify(provider.requests[2].body.input)).not.toContain('Personal analysis');
  });

  it('preserves a draft when the selected account has no available models', async ({ glyph, provider }) => {
    await glyph.composer.fill('Keep this draft');
    await history(glyph);
    await glyph.page
      .getByRole('combobox', { name: 'Account', exact: true })
      .selectOption({ label: 'empty@example.invalid' });
    await closeHistory(glyph);
    await expect(glyph.page.getByRole('combobox', { name: 'Model', exact: true })).toBeDisabled();
    await expect(glyph.page.locator('.glyph-workbench').getByRole('alert')).toContainText(/No.*models.*available/i);
    await expect(glyph.composer).toHaveValue('Keep this draft');
    expect(provider.requests).toHaveLength(0);
    await history(glyph);
    await glyph.page
      .getByRole('combobox', { name: 'Account', exact: true })
      .selectOption({ label: 'personal@example.invalid' });
    await closeHistory(glyph);
    provider.enqueue({ chunks: ['Recovered after selection.'] });
    await glyph.sendButton.click();
    await expect(glyph.assistantEntries.locator('div')).toHaveText(['Recovered after selection.']);
    expect(
      provider.requests[0].body.input.some(item => item.role === 'user' && item.content === 'Keep this draft'),
    ).toBe(true);
  });
});
