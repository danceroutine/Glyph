import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */

/** @param {GlyphWorkbench} glyph */
async function history(glyph) {
  const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return glyph.page.getByRole('navigation', { name: 'Saved chats' });
}

/** @param {GlyphWorkbench} glyph */
async function closeHistory(glyph) {
  const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
}

/**
 * @param {GlyphWorkbench} glyph
 * @param {string} name
 */
async function openChat(glyph, name) {
  const list = await history(glyph);
  await glyph.page.getByRole('searchbox', { name: 'Search chats' }).fill(name);
  await list.getByRole('button').filter({ hasText: name }).click();
  await closeHistory(glyph);
}

it.describe('Saved chats and new conversation setup', () => {
  it.use({ scriptedProvider: true });

  it('branches an answer and restores a user checkpoint with independent durable provider history', async ({
    glyph,
    provider,
  }, testInfo) => {
    provider.enqueue(
      { chunks: ['First answer.'] },
      { chunks: ['Second answer.'] },
      { chunks: ['Branch answer.'] },
      { chunks: ['Replacement answer.'] },
    );
    await glyph.send('Original first message');
    await expect(glyph.userEntries).toContainText('Original first message');
    await expect(glyph.assistantEntries.last().getByRole('button', { name: 'Branch chat' })).toBeVisible();
    await glyph.send('Original second message');
    await expect(glyph.assistantEntries.last().getByRole('button', { name: 'Branch chat' })).toBeVisible();
    await expect(glyph.assistantEntries).toHaveCount(2);
    await glyph.assistantEntries.first().getByRole('button', { name: 'Branch chat' }).click();
    await expect(glyph.assistantEntries).toHaveCount(1);
    await expect(glyph.assistantEntries.first()).toContainText('First answer.');
    await glyph.send('Branch follow-up');
    await expect(glyph.assistantEntries.last()).toContainText('Branch answer.');
    await expect(glyph.assistantEntries.last().getByRole('button', { name: 'Branch chat' })).toBeVisible();
    const branchInput = JSON.stringify(provider.requests[2].body.input);
    expect(branchInput).toContain('Original first message');
    expect(branchInput).not.toContain('Original second message');
    await glyph.crashHost();
    await glyph.reload();
    await expect(glyph.assistantEntries).toHaveCount(2);
    const list = await history(glyph);
    await glyph.page.getByRole('searchbox', { name: 'Search chats' }).fill('Original');
    await list
      .getByRole('button')
      .filter({ hasText: 'Original First Message' })
      .filter({ hasNotText: 'Branch' })
      .click();
    await closeHistory(glyph);
    await expect(glyph.assistantEntries.last()).toContainText('Second answer.');
    await glyph.composer.fill('Preserve this unsent draft');
    await glyph.userEntries.last().hover();
    await glyph.userEntries.last().getByRole('button', { name: 'Restore checkpoint' }).click();
    await expect(glyph.assistantEntries).toHaveCount(1);
    await expect(glyph.composer).toHaveText('Original second message');
    await expect(glyph.page.getByRole('region', { name: 'Unsent messages' })).toContainText(
      'Preserve this unsent draft',
    );
    await glyph.send('Replacement prompt');
    await expect(glyph.assistantEntries.last()).toContainText('Replacement answer.');
    await expect(glyph.assistantEntries.last().getByRole('button', { name: 'Branch chat' })).toBeVisible();
    const restoredInput = JSON.stringify(provider.requests[3].body.input);
    expect(restoredInput).toContain('Original first message');
    expect(restoredInput).toContain('Replacement prompt');
    expect(restoredInput).not.toContain('Original second message');
    expect(restoredInput).not.toContain('Branch follow-up');
    await glyph.crashHost();
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
      'First answer.',
      'Replacement answer.',
    ]);
    await glyph.userEntries.last().hover();
    await testInfo.attach('message-actions', { body: await glyph.page.screenshot(), contentType: 'image/png' });
  });

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
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.composer.fill('Unsent alpha draft');
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(glyph.composer).toHaveText('');
    await glyph.send('Beta project');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.composer.fill('Unsent beta draft');
    const list = await history(glyph);
    const chats = list.getByRole('region').getByRole('button');
    await expect(chats).toHaveCount(2);
    await expect(chats.first()).toContainText('Beta Project');
    const search = glyph.page.getByRole('searchbox', { name: 'Search chats' });
    await search.fill('No such conversation');
    await expect(list).toContainText('No matching chats.');
    await search.fill('Alpha');
    await expect(chats).toHaveCount(1);
    await chats.click();
    await closeHistory(glyph);
    await expect(glyph.composer).toHaveText('Unsent alpha draft');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['The alpha answer.']);
    await glyph.page.getByRole('button', { name: 'Conversation token usage' }).click();
    await expect(glyph.page.getByRole('dialog', { name: 'Conversation token usage' }).locator('dd').last()).toHaveText(
      '14',
    );
    await glyph.page.keyboard.press('Escape');
    await glyph.page.locator('.glyph-reasoning summary').click();
    await expect(glyph.page.locator('.glyph-reasoning p')).toHaveText('Alpha reasoning.');
    await openChat(glyph, 'Beta');
    await expect(glyph.composer).toHaveText('Unsent beta draft');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['The beta answer.']);
    await glyph.page.getByRole('button', { name: 'Conversation token usage' }).click();
    await expect(glyph.page.getByRole('dialog', { name: 'Conversation token usage' }).locator('dd').last()).toHaveText(
      '27',
    );
    await glyph.page.keyboard.press('Escape');
    await openChat(glyph, 'Alpha');
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['The alpha answer.']);
    await glyph.crashHost();
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['The alpha answer.']);
    await glyph.page.getByRole('button', { name: 'Conversation token usage' }).click();
    await expect(glyph.page.getByRole('dialog', { name: 'Conversation token usage' }).locator('dd').last()).toHaveText(
      '14',
    );
    await glyph.page.keyboard.press('Escape');
    await history(glyph);
    const panel = await glyph.page.locator('.part.auxiliarybar').boundingBox();
    const sashes = await glyph.page.locator('.monaco-sash.vertical').all();
    const candidates = (await Promise.all(sashes.map(sash => sash.boundingBox()))).filter(Boolean);
    const sash = candidates.toSorted(
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
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['Beta finished.']);
    provider.release(0);
    await expect.poll(() => provider.requests[0].completed).toBe(true);
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['Beta finished.']);
    await openChat(glyph, 'Alpha');
    await expect(glyph.composer).toHaveText('Alpha next prompt');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['Alpha still running.']);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
  });
});

it.describe('Pending chat archiving', () => {
  it.fixme(
    'archives a chat from history, hides it from the active chat list, and preserves its conversation in the archive after reload and host restart',
    async () => {},
  );
  it.fixme(
    'unarchives a chat into the active chat list and resumes the same conversation with its original provider history after reload and host restart',
    async () => {},
  );
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
    await model.click();
    await glyph.page.getByRole('option', { name: 'Work deep', exact: true }).click();
    await glyph.composer.fill('Work analysis');
    await history(glyph);
    await testInfo.attach('account-footer', { body: await glyph.page.screenshot(), contentType: 'image/png' });
    await closeHistory(glyph);
    provider.enqueue({ chunks: ['Work answer.'] });
    await glyph.sendButton.click();
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(provider.requests[0]).toMatchObject({ account: 'work', body: { model: 'work-deep' } });
    await expect(model).toBeDisabled();
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await history(glyph);
    await account.selectOption({ label: 'personal@example.invalid' });
    await closeHistory(glyph);
    await expect(model).toHaveText('Personal model');
    provider.enqueue({ chunks: ['Personal answer.'] });
    await glyph.send('Personal analysis');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(provider.requests[1]).toMatchObject({ account: 'personal', body: { model: 'personal-model' } });
    await openChat(glyph, 'Work');
    // The other account's catalog is still loaded, so restored chats display their model slug.
    await expect(model).toHaveText('work-deep');
    await history(glyph);
    await expect(account.locator('option:checked')).toHaveText('work@example.invalid');
    await expect(account).toBeDisabled();
    await closeHistory(glyph);
    await glyph.crashHost();
    await glyph.reload();
    provider.enqueue({ chunks: ['Work continued.'] });
    await glyph.send('Continue the work conversation');
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
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
    await expect(glyph.page.locator('.glyph-workbench').getByRole('alert')).toContainText(/No.*models.*available/iu);
    await expect(glyph.composer).toHaveText('Keep this draft');
    expect(provider.requests).toHaveLength(0);
    await history(glyph);
    await glyph.page
      .getByRole('combobox', { name: 'Account', exact: true })
      .selectOption({ label: 'personal@example.invalid' });
    await closeHistory(glyph);
    provider.enqueue({ chunks: ['Recovered after selection.'] });
    await glyph.sendButton.click();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['Recovered after selection.']);
    expect(
      provider.requests[0].body.input.some(item => item.role === 'user' && item.content === 'Keep this draft'),
    ).toBe(true);
  });
});
