import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { contextEventMessage, parseJson, shellToolOutput } from './ProviderPayloads.mjs';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

/** @typedef {import('./GlyphWorkbench.mjs').GlyphWorkbench} GlyphWorkbench */

const firstTerminal = isolatedLaunch('expects the first terminal of a fresh window');
/**
 * @param {string} name
 * @param {unknown} args
 */
const tool = (name, args) => ScriptedProvider.tool(name, args, { namespace: 'shell', callId: randomUUID() });
/** @param {GlyphWorkbench} glyph */
const card = glyph => glyph.page.getByRole('region', { name: 'Shell command', exact: true }).first();
/** @param {GlyphWorkbench} glyph */
const drawer = glyph => glyph.page.getByRole('region', { name: 'Background terminals', exact: true });
/** @param {GlyphWorkbench} glyph */
const finished = glyph => expect(glyph.sendButton).toHaveText('Send (Enter)');
/** @param {ScriptedProvider} provider */
const contexts = provider =>
  provider.requests.flatMap(request =>
    request.body.input.flatMap(item => {
      if (typeof item.content !== 'string') return [];
      try {
        const parsed = contextEventMessage.safeParse(parseJson(item.content));
        return parsed.success && parsed.data.schema === 'glyph.context-event.v1'
          ? [{ ...parsed.data.event, role: item.role }]
          : [];
      } catch {
        return [];
      }
    }),
  );
/**
 * @param {GlyphWorkbench} glyph
 * @param {ScriptedProvider} provider
 * @param {string} command
 */
async function start(glyph, provider, command, wake = 'READY') {
  const call = tool('execute_shell', {
    command,
    terminal_id: null,
    working_directory: null,
    background: true,
    wake_on: wake,
    timeout_ms: 5000,
  });
  provider.enqueue({ output: [call] }, { chunks: ['Background terminal started.'] });
  await glyph.send('Start a background command.');
  await glyph.page
    .getByRole('region', { name: 'Command approval' })
    .getByRole('button', { name: 'Run', exact: true })
    .click();
  await finished(glyph);
  await expect(drawer(glyph)).toContainText('1 background terminal');
  await card(glyph).getByRole('button').first().click();
  const output = provider.requests[1].body.input.find(
    item => item.type === 'function_call_output' && item.call_id === call.call_id,
  );
  return shellToolOutput.parse(parseJson(output?.output)).terminal_id;
}
/**
 * @param {GlyphWorkbench} glyph
 * @param {string} text
 */
async function input(glyph, text) {
  await card(glyph).getByRole('textbox', { name: 'Input to shell' }).fill(text);
  await card(glyph).getByRole('button', { name: 'Send input', exact: true }).click();
  const field = card(glyph).getByRole('textbox', { name: 'Input to shell' });
  await expect.poll(async () => (await field.count()) === 0 || (await field.inputValue()) === '').toBe(true);
}

it.describe('Background shell wakes and native terminal drawer', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true });

  for (const stopWith of ['drawer', 'native terminal'])
    it(
      `returns control, opens the read-only terminal, and reports Stop from the ${stopWith}`,
      firstTerminal,
      async ({ glyph, provider }, testInfo) => {
        await start(
          glyph,
          provider,
          `trap 'printf "READY after stop\\n"; exit 0' TERM; printf "ticker started\\n"; while :; do sleep 1; done`,
        );
        await expect(card(glyph)).toContainText('Wake on: READY');
        await drawer(glyph).getByRole('button', { name: '1 background terminal', exact: true }).click();
        await expect(drawer(glyph)).toContainText('Wake on: READY');
        await drawer(glyph)
          .getByRole('button', { name: /printf/u })
          .click();
        await expect(glyph.page.locator('.terminal-wrapper')).toBeVisible();
        const terminalInput = glyph.page.getByRole('textbox', { name: /^Terminal 1,/u });
        await expect(terminalInput).toBeFocused();
        await terminalInput.pressSequentially('READ ONLY INPUT');
        await terminalInput.press('Enter');
        await expect(drawer(glyph)).toContainText('1 background terminal');
        // The native terminal's accessibility buffer contains the host's actual output.
        await glyph.command('Open Accessible View');
        await expect(glyph.page.locator('.accessible-view')).toContainText('ticker started');
        await expect(glyph.page.locator('.accessible-view')).toContainText('Agent terminals are read-only');
        await expect(glyph.page.locator('.accessible-view')).not.toContainText('READ ONLY INPUT');
        await glyph.page.keyboard.press('Escape');
        await glyph.open();
        await glyph.page.screenshot({ path: testInfo.outputPath('background-terminal.png') });
        provider.enqueue({ chunks: ['The terminal was stopped; its last output was ticker started.'] });
        if (stopWith === 'drawer') await drawer(glyph).getByRole('button', { name: 'Stop', exact: true }).click();
        else await glyph.command('Terminal: Kill the Active Terminal Instance');
        await expect(drawer(glyph)).toHaveCount(0);
        await expect(glyph.diagnostics).toContainText('Stopped trap');
        await expect(glyph.assistantEntries.last()).toContainText('The terminal was stopped');
        expect(contexts(provider).some(event => event.type === 'shell_wake')).toBe(false);
        expect(contexts(provider).find(event => event.type === 'shell_exit')?.payload?.outputTail).toContain(
          'READY after stop',
        );
        expect(provider.requests).toHaveLength(3);
        expect(contexts(provider).filter(event => event.type === 'shell_exit')).toEqual([
          expect.objectContaining({
            role: 'user',
            payload: expect.objectContaining({
              reason: 'stopped',
              outputTail: expect.stringContaining('ticker started'),
            }),
          }),
        ]);
      },
    );

  it('wakes its owning agent with the literal match and output as durable context', async ({ glyph, provider }) => {
    await start(glyph, provider, 'read line; printf "READY with output\\n"; sleep 60');
    provider.enqueue({ chunks: ['I received the ready output.'] });
    await input(glyph, 'go');
    await expect(glyph.assistantEntries.last()).toContainText('I received the ready output.');
    expect(contexts(provider)).toContainEqual(
      expect.objectContaining({
        type: 'shell_wake',
        role: 'user',
        payload: expect.objectContaining({ pattern: 'READY', output: expect.stringContaining('READY with output') }),
      }),
    );
    await finished(glyph);
    expect(provider.requests).toHaveLength(3);
  });

  it('matches across chunks and ignores unrelated output', async ({ glyph, provider }) => {
    await start(glyph, provider, 'printf "unrelated\\n"; read line; printf REA; read line; printf "DY\\n"; sleep 60');
    await input(glyph, 'first');
    await expect(card(glyph).getByLabel('Command output')).toContainText('REA');
    expect(provider.requests).toHaveLength(2);
    provider.enqueue({ chunks: ['The split literal matched.'] });
    await input(glyph, 'second');
    await expect(glyph.assistantEntries.last()).toContainText('The split literal matched.');
    expect(contexts(provider)).toContainEqual(
      expect.objectContaining({
        type: 'shell_wake',
        payload: expect.objectContaining({ output: 'unrelated\nREADY\n' }),
      }),
    );
  });

  it('fires a one-shot condition once despite repeated matching output', async ({ glyph, provider }) => {
    await start(
      glyph,
      provider,
      'read line; printf "READY READY\\n"; read line; printf "READY repeated later\\n"; sleep 60',
    );
    provider.enqueue({ chunks: ['One wake only.'] });
    await input(glyph, 'first');
    await expect(glyph.assistantEntries.last()).toContainText('One wake only.');
    await input(glyph, 'second');
    await expect(card(glyph).getByLabel('Command output')).toContainText('repeated later');
    expect(provider.requests).toHaveLength(3);
  });

  it('lets the agent replace and re-arm wake text using shell input', async ({ glyph, provider }) => {
    const id = await start(glyph, provider, 'while read line; do printf "%s\\n" "$line"; done');
    const replace = tool('write_shell_input', {
      terminal_id: id,
      input: 'unrelated',
      append_newline: true,
      wake_on: 'NEXT',
    });
    provider.enqueue({ output: [replace] }, { chunks: ['Now waiting for NEXT.'] });
    await glyph.send('Replace the wake with NEXT.');
    await expect(glyph.assistantEntries.last()).toContainText('Now waiting for NEXT.');
    await input(glyph, 'READY');
    await expect(card(glyph).getByLabel('Command output')).toContainText('READY');
    expect(provider.requests).toHaveLength(4);
    const rearm = tool('write_shell_input', { terminal_id: id, input: '', append_newline: false, wake_on: 'AGAIN' });
    provider.enqueue({ output: [rearm] }, { chunks: ['Re-armed for AGAIN.'] });
    await input(glyph, 'NEXT');
    await expect(glyph.assistantEntries.last()).toContainText('Re-armed for AGAIN.');
    provider.enqueue({ chunks: ['The re-armed match arrived.'] });
    await input(glyph, 'AGAIN');
    await expect(glyph.assistantEntries.last()).toContainText('The re-armed match arrived.');
    expect(provider.requests).toHaveLength(7);
  });

  it('waits behind an active turn and stacks terminals above queued messages', async ({ glyph, provider }) => {
    await start(glyph, provider, 'read line; printf "READY\\n"; sleep 60');
    provider.enqueue({ chunks: ['Working on another task.'], hold: true });
    await glyph.send('Do another task.');
    await expect(glyph.assistantEntries.last()).toContainText('Working on another task.');
    await glyph.composer.fill('A queued follow-up.');
    await glyph.composer.press('Enter');
    const queue = glyph.page.getByRole('region', { name: 'Queued messages', exact: true });
    await expect(queue).toBeVisible();
    const terminalBounds = await drawer(glyph).boundingBox();
    const queueBounds = await queue.boundingBox();
    expect(terminalBounds.y).toBeLessThan(queueBounds.y);
    await input(glyph, 'go');
    await expect(card(glyph).getByLabel('Command output')).toContainText('READY');
    expect(provider.requests).toHaveLength(3);
    provider.enqueue({ chunks: ['Ready notification handled.'] }, { chunks: ['Queued follow-up handled.'] });
    provider.release(2);
    await expect(glyph.assistantEntries.last()).toContainText('Queued follow-up handled.');
    expect(provider.requests).toHaveLength(5);
    expect(
      contexts(provider)
        .filter(event => event.type === 'shell_wake')
        .map(event => event.id),
    ).toEqual([expect.any(String), expect.any(String)]);
    await expect(queue).toHaveCount(0);
  });

  it('keeps late wakes in the owning chat while another chat is selected', async ({ glyph, provider }) => {
    await start(glyph, provider, 'while [ ! -f wake-signal ]; do sleep 0.05; done; printf "READY\\n"; sleep 60');
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    provider.enqueue({ chunks: ['The owning chat received READY.'] });
    await writeFile(join(glyph.workspace, 'wake-signal'), 'go');
    await expect.poll(() => provider.requests.length).toBe(3);
    await expect(drawer(glyph)).toHaveCount(0);
    await expect(glyph.assistantEntries).toHaveCount(0);
    expect(contexts(provider)).toContainEqual(
      expect.objectContaining({ type: 'shell_wake', payload: expect.objectContaining({ pattern: 'READY' }) }),
    );
  });

  it('shows command failure and continues with final output even without a literal match', async ({
    glyph,
    provider,
  }) => {
    await start(glyph, provider, 'read line; printf "failure detail\\n"; exit 7', 'NEVER');
    provider.enqueue({ chunks: ['The command exited with code 7 before its wake condition.'] });
    await input(glyph, 'exit');
    await expect(glyph.assistantEntries.last()).toContainText('exited with code 7');
    await expect(card(glyph)).toContainText('Exit 7');
    await expect(drawer(glyph)).toHaveCount(0);
    expect(contexts(provider)).toContainEqual(
      expect.objectContaining({
        type: 'shell_exit',
        role: 'user',
        payload: expect.objectContaining({ exitCode: 7, outputTail: 'failure detail\n', reason: 'exited' }),
      }),
    );
    expect(contexts(provider).some(event => event.type === 'shell_wake')).toBe(false);
  });
});
