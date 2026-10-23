import { expect, test as it } from './GlyphWorkbench.fixture.mjs';

it.describe('Desktop recovery and window ownership with the production runtime', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });

  it('restores a partial answer without duplicating streamed text after reconnecting', async ({ glyph, provider }) => {
    const prefix = 'Before reconnect: café 🌱\nA partial answer.';
    provider.enqueue({ chunks: ['Before reconnect: café 🌱\n', 'A partial answer.'], hold: true });
    await glyph.send('Keep this partial answer across reload.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([prefix]);
    await expect(glyph.sendButton).toHaveText('Cancel');
    await glyph.reload();
    await expect(glyph.userEntries.locator('[data-glyph-source]')).toHaveText([
      'Keep this partial answer across reload.',
    ]);
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([prefix]);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect.poll(() => provider.requests[0].closed).toBe(true);
    expect(provider.requests[0].completed).toBe(false);
    expect(provider.requests).toHaveLength(1);
    // The disconnected response must not complete or duplicate text in the new renderer.
    provider.release(0);
    provider.enqueue({ chunks: ['The next turn works.'] });
    await glyph.send('Continue with a new turn.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([prefix, 'The next turn works.']);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([prefix, 'The next turn works.']);
    expect(provider.requests).toHaveLength(2);
  });

  it('recovers from a stopped utility host and clearly explains the interrupted answer', async ({
    glyph,
    provider,
  }) => {
    provider.enqueue(
      { chunks: ['A durable completed answer.'] },
      { chunks: ['An interrupted partial answer.'], hold: true },
    );
    await glyph.send('Persist this completed turn.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText(['A durable completed answer.']);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.diagnostics).toHaveCount(0);
    await glyph.send('Start a turn that will be interrupted.');
    await expect(glyph.assistantEntries.last()).toContainText('An interrupted partial answer.');
    await expect(glyph.sendButton).toHaveText('Cancel');
    await glyph.crashHost();
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.diagnostics).toContainText([/host exited.*interrupted/iu]);
    await expect(glyph.assistantEntries.last()).toContainText('An interrupted partial answer.');
    await expect.poll(() => provider.requests[1].closed).toBe(true);
    expect(provider.requests).toHaveLength(2);
    provider.enqueue({ chunks: ['A new answer after the restart.'] });
    await glyph.send('Continue after the host restart.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
      'A durable completed answer.',
      'A new answer after the restart.',
    ]);
    await expect(glyph.userEntries.locator('[data-glyph-source]')).toHaveText([
      'Persist this completed turn.',
      'Continue after the host restart.',
    ]);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    expect(provider.requests).toHaveLength(3);
    const input = provider.requests[2].body.input;
    expect(input.filter(item => item.role === 'user').map(item => item.content)).toEqual([
      'Persist this completed turn.',
      'Continue after the host restart.',
    ]);
    expect(input.filter(item => item.role === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(input)).toContain('A durable completed answer.');
    // Restart again to distinguish persisted history from the host's in-memory projections.
    await glyph.crashHost();
    await glyph.reload();
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
      'A durable completed answer.',
      'A new answer after the restart.',
    ]);
    expect(provider.requests).toHaveLength(3);
  });

  it('keeps a second window read-only while another window owns the same workspace', async ({ glyph, provider }) => {
    provider.enqueue({ chunks: ['The owner is still working.'], hold: true });
    await glyph.send('Keep ownership while this turn runs.');
    await expect(glyph.assistantEntries).toContainText(['The owner is still working.']);
    const duplicate = await glyph.duplicateWorkspace();
    const draft = 'Do not run a second agent against these files.';
    await duplicate.composer.fill(draft);
    await expect(duplicate.diagnostics).toContainText([/overlap.*owned by window/iu]);
    await expect(duplicate.sendButton).toBeDisabled();
    await expect(duplicate.composer).toHaveText(draft);
    await expect(duplicate.assistantEntries).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Cancel');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].closed).toBe(false);
    await duplicate.reload();
    await duplicate.composer.fill(draft);
    await expect(duplicate.diagnostics).toContainText([/overlap.*owned by window/iu]);
    await expect(duplicate.sendButton).toBeDisabled();
    await expect(duplicate.composer).toHaveText(draft);
    expect(provider.requests).toHaveLength(1);
    provider.release(0);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.diagnostics).toHaveCount(0);
    provider.enqueue({ chunks: ['Only the owner continued.'] });
    await glyph.send('Continue in the owning window.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
      'The owner is still working.',
      'Only the owner continued.',
    ]);
    expect(provider.requests).toHaveLength(2);
    await expect(duplicate.assistantEntries).toHaveCount(0);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await expect(glyph.diagnostics).toHaveCount(0);
  });
});
