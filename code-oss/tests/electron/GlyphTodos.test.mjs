import { randomUUID } from 'node:crypto';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const items = [
  { id: 'inspect', text: 'Inspect the current implementation', status: 'completed' },
  { id: 'implement', text: 'Implement the requested change', status: 'in_progress' },
  { id: 'verify', text: 'Verify café 🌱 and Unicode behavior', status: 'pending' },
];
const card = glyph => glyph.page.getByRole('region', { name: 'To-dos', exact: true });
const update = (items, replace = false, callId = randomUUID()) =>
  ScriptedProvider.tool('update_todos', { items, replace }, { namespace: 'todo', callId });

async function runUpdate(
  glyph,
  provider,
  next,
  { replace = false, hold = false, prompt = 'Maintain these action items.' } = {},
) {
  const callId = randomUUID();
  const before = provider.requests.length;
  provider.enqueue({ output: [update(next, replace, callId)] }, { chunks: ['Todo update recorded.'], hold });
  await glyph.send(prompt);
  await expect.poll(() => provider.requests.length).toBe(before + 2);
  if (!hold) await expect(glyph.sendButton).toHaveText('Send (Enter)');
  const outputs = provider.requests
    .at(-1)
    .body.input.filter(value => value.type === 'function_call_output' && value.call_id === callId);
  expect(outputs).toHaveLength(1);
  return JSON.parse(outputs[0].output);
}

async function expand(glyph) {
  const toggle = card(glyph).getByRole('button');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

async function openChat(glyph, name) {
  const toggle = glyph.page.getByRole('button', { name: 'Chat history', exact: true });
  await toggle.click();
  await glyph.page.getByRole('searchbox', { name: 'Search chats' }).fill(name);
  await glyph.page
    .getByRole('navigation', { name: 'Saved chats' })
    .getByRole('button')
    .filter({ hasText: name })
    .click();
  if ((await toggle.getAttribute('aria-expanded')) === 'true') await toggle.click();
}

it.describe('Action items and read-only todo cards', () => {
  it.use({ scriptedProvider: true });

  it('shows distinct pending, in-progress, and completed items in a read-only card that expands upward', async ({
    glyph,
    provider,
  }, testInfo) => {
    expect(await runUpdate(glyph, provider, items)).toEqual({ items });
    const toggle = card(glyph).getByRole('button', { name: '1 of 3 To-dos completed' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card(glyph).getByRole('listitem')).toHaveCount(0);
    const before = await card(glyph).boundingBox();
    const composerBefore = await glyph.composer.boundingBox();
    await testInfo.attach('collapsed-todos', {
      body: await glyph.page.screenshot({ path: testInfo.outputPath('collapsed-todos.png') }),
      contentType: 'image/png',
    });
    await toggle.focus();
    await glyph.page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card(glyph).getByRole('listitem')).toHaveText([
      'Inspect the current implementation',
      'Implement the requested change',
      'Verify café 🌱 and Unicode behavior',
    ]);
    for (const status of ['Completed', 'In progress', 'Pending'])
      await expect(card(glyph).getByRole('img', { name: status, exact: true })).toHaveCount(1);
    await expect(card(glyph).getByRole('checkbox')).toHaveCount(0);
    await expect(card(glyph).getByRole('textbox')).toHaveCount(0);
    const after = await card(glyph).boundingBox();
    expect(after.y).toBeLessThan(before.y);
    expect(Math.abs(after.y + after.height - before.y - before.height)).toBeLessThan(2);
    expect(Math.abs((await glyph.composer.boundingBox()).y - composerBefore.y)).toBeLessThan(2);
    await testInfo.attach('expanded-todos', {
      body: await glyph.page.screenshot({ path: testInfo.outputPath('expanded-todos.png') }),
      contentType: 'image/png',
    });
  });

  it('updates an existing item by ID without duplicating or losing items and preserves expansion', async ({
    glyph,
    provider,
  }) => {
    await runUpdate(glyph, provider, items);
    await expand(glyph);
    const completed = { ...items[1], status: 'completed' };
    expect(await runUpdate(glyph, provider, [completed], { hold: true })).toEqual({
      items: [items[0], completed, items[2]],
    });
    await expect(card(glyph).getByRole('button')).toHaveText('⌃2 of 3 To-dos completed');
    await expect(card(glyph).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await expect(card(glyph).getByRole('listitem')).toHaveCount(3);
    await expect(
      card(glyph).getByRole('listitem').nth(1).getByRole('img', { name: 'Completed', exact: true }),
    ).toBeVisible();
    provider.release(3);
    await expect(glyph.sendButton).toHaveText('Send (Enter)');
    await runUpdate(glyph, provider, [completed]);
    await expect(card(glyph).getByRole('listitem')).toHaveCount(3);
  });

  for (const ending of ['completion', 'cancellation', 'host failure']) {
    it(`keeps unfinished items after ${ending} and restores them after reload`, async ({ glyph, provider }) => {
      await runUpdate(glyph, provider, items, { hold: ending !== 'completion' });
      if (ending === 'cancellation') {
        await glyph.sendButton.click();
        await expect(glyph.sendButton).toHaveText('Send (Enter)');
      }
      if (ending === 'host failure') await glyph.crashHost();
      await expect(card(glyph).getByRole('button', { name: '1 of 3 To-dos completed' })).toBeVisible();
      await glyph.reload();
      await expect(card(glyph).getByRole('button', { name: '1 of 3 To-dos completed' })).toBeVisible();
      await expand(glyph);
      await expect(
        card(glyph).getByRole('listitem').nth(1).getByRole('img', { name: 'In progress', exact: true }),
      ).toBeVisible();
      await expect(
        card(glyph).getByRole('listitem').nth(2).getByRole('img', { name: 'Pending', exact: true }),
      ).toBeVisible();
    });
  }

  it('restores separate chat lists after reload and host restart without background completion stealing selection', async ({
    glyph,
    provider,
  }) => {
    const alpha = [{ id: 'shared', text: 'Alpha work', status: 'pending' }];
    const beta = [{ id: 'shared', text: 'Beta work', status: 'completed' }];
    await runUpdate(glyph, provider, alpha, { prompt: 'Alpha tasks', hold: true });
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(card(glyph)).toHaveCount(0);
    await runUpdate(glyph, provider, beta, { prompt: 'Beta tasks' });
    provider.release(1);
    await expect.poll(() => provider.requests[1].completed).toBe(true);
    await expect(card(glyph).getByRole('button', { name: '1 of 1 To-dos completed' })).toBeVisible();
    await expand(glyph);
    await expect(card(glyph).getByRole('listitem')).toContainText(['Beta work']);
    await openChat(glyph, 'Alpha');
    await expect(card(glyph).getByRole('button', { name: '0 of 1 To-dos completed' })).toBeVisible();
    await glyph.reload();
    await expand(glyph);
    await expect(card(glyph).getByRole('listitem')).toContainText(['Alpha work']);
    await glyph.crashHost();
    await glyph.reload();
    await openChat(glyph, 'Beta');
    await expand(glyph);
    await expect(card(glyph).getByRole('listitem')).toContainText(['Beta work']);
    await expect(card(glyph)).not.toContainText('Alpha work');
  });

  it('rejects malformed updates without changing the list and supports deliberate replacement and clearing', async ({
    glyph,
    provider,
  }) => {
    await runUpdate(glyph, provider, items);
    expect(await runUpdate(glyph, provider, [items[0], items[0]])).toMatchObject({ error: { code: 'MALFORMED' } });
    await expect(card(glyph).getByRole('button', { name: '1 of 3 To-dos completed' })).toBeVisible();
    const replacement = [{ id: 'new', text: 'A new task', status: 'pending' }];
    expect(await runUpdate(glyph, provider, replacement, { replace: true })).toEqual({ items: replacement });
    await expect(card(glyph).getByRole('button', { name: '0 of 1 To-dos completed' })).toBeVisible();
    expect(await runUpdate(glyph, provider, [], { replace: true })).toEqual({ items: [] });
    await expect(card(glyph)).toHaveCount(0);
    await glyph.reload();
    await expect(card(glyph)).toHaveCount(0);
  });
});
