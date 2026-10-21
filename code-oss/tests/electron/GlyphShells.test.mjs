import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, isolatedLaunch, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

const restartsHost = isolatedLaunch('restarts the host and reloads the window');
const tool = (name, input) => ScriptedProvider.tool(name, input, { namespace: 'shell', callId: randomUUID() });
const execute = (command, options = {}) =>
  tool('execute_shell', {
    command,
    terminal_id: null,
    working_directory: null,
    background: false,
    wake_on: null,
    timeout_ms: 5000,
    ...options,
  });
const write = (id, input, appendNewline = true) =>
  tool('write_shell_input', { terminal_id: id, input, append_newline: appendNewline, wake_on: null });
const close = id => tool('close_shell', { terminal_id: id });
const list = () => tool('list_shells', {});
const cards = glyph => glyph.page.getByRole('region', { name: 'Shell command', exact: true });
const finished = glyph => expect(glyph.sendButton).toHaveText('Send (Enter)');
const result = (provider, call) =>
  JSON.parse(
    provider.requests
      .at(-1)
      .body.input.find(item => item.type === 'function_call_output' && item.call_id === call.call_id).output,
  );
async function runTool(glyph, provider, call, notifiesExit = false) {
  const count = provider.requests.length;
  provider.enqueue({ output: [call] }, { chunks: ['Shell step complete.'] });
  if (notifiesExit) provider.enqueue({ chunks: ['Background terminal stopped.'] });
  await glyph.send('Perform the shell operation.');
  await expect.poll(() => provider.requests.length).toBe(count + (notifiesExit ? 3 : 2));
  await finished(glyph);
  return result(provider, call);
}
async function runCommand(glyph, provider, call, notifiesExit = false) {
  provider.enqueue({ output: [call] });
  await glyph.send('Run the requested command.');
  const approval = glyph.page.getByRole('region', { name: 'Command approval' });
  await expect(approval).toBeVisible();
  provider.enqueue({ chunks: ['Shell step complete.'] });
  if (notifiesExit) provider.enqueue({ chunks: ['Background terminal exited.'] });
  await approval.getByRole('button', { name: 'Run', exact: true }).click();
  if (notifiesExit) await expect(glyph.assistantEntries.last()).toContainText('Background terminal exited.');
  await finished(glyph);
  return result(provider, call);
}
async function startInteractive(glyph, provider) {
  const call = execute('printf "READY\\n"; read line; printf "GOT:%s\\n" "$line"; sleep 60', { background: true });
  const output = await runCommand(glyph, provider, call);
  await expect(cards(glyph).first().getByLabel('Command output')).toContainText('READY');
  return output.terminal_id;
}
async function file(glyph, path) {
  return readFile(join(glyph.workspace, path), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

it.describe('Shell execution, input, close, and listing', () => {
  it.describe.configure({ mode: 'default' });
  it.use({ sharedLaunch: true, scriptedProvider: true, workspaceFiles: { 'nested/.keep': '' } });

  it(
    'runs an approved command in the requested workspace directory and shows its output and exit status',
    restartsHost,
    async ({ glyph, provider }, testInfo) => {
      const output = await runCommand(
        glyph,
        provider,
        execute('pwd; printf "first\\nsecond\\nthird\\nfourth\\n"', { working_directory: 'nested' }),
      );
      expect(output.exit_code).toBe(0);
      expect(output.output).toContain(join(glyph.workspace, 'nested'));
      const card = cards(glyph).first();
      const toggle = card.getByRole('button').first();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(card.getByLabel('Command output')).toHaveText('second\nthird\nfourth');
      await glyph.page.screenshot({ path: testInfo.outputPath('collapsed-command.png') });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(card).toContainText('Exit 0');
      await expect(card.getByLabel('Command output')).toContainText('first');
      await expect(card).toContainText(join(glyph.workspace, 'nested'));
      await glyph.page.screenshot({ path: testInfo.outputPath('expanded-command.png') });
      await glyph.crashHost();
      await glyph.reload();
      await cards(glyph).first().getByRole('button').first().click();
      await expect(cards(glyph).first().getByLabel('Command output')).toContainText('first');
      await expect(cards(glyph).first()).toContainText('Exit 0');
    },
  );

  it('keeps a command from running while approval is pending or after the user denies it', async ({
    glyph,
    provider,
  }) => {
    const call = execute('printf denied > denied.txt');
    provider.enqueue({ output: [call] });
    await glyph.send('Request a write.');
    const approval = glyph.page.getByRole('region', { name: 'Command approval' });
    await expect(approval).toBeVisible();
    expect(await file(glyph, 'denied.txt')).toBeNull();
    provider.enqueue({ chunks: ['Declined.'] });
    await approval.getByRole('button', { name: 'Skip', exact: true }).click();
    await finished(glyph);
    expect(await file(glyph, 'denied.txt')).toBeNull();
    expect(result(provider, call).error.message).toMatch(/denied/i);
    await expect(cards(glyph).first()).toContainText('Failed');
  });

  it('shows a nonzero exit as a failed command and lets the agent explain the returned error', async ({
    glyph,
    provider,
  }) => {
    const output = await runCommand(glyph, provider, execute('printf "failure detail\\n" >&2; exit 7'));
    expect(output).toMatchObject({ exit_code: 7, error: { code: 'COMMAND_EXITED' } });
    await expect(cards(glyph).first()).toContainText('Failed · Exit 7');
    await expect(cards(glyph).first().getByLabel('Command output')).toContainText('failure detail');
    await expect(glyph.assistantEntries.last()).toContainText('Shell step complete.');
  });

  it('stops a timed-out or cancelled foreground command and restores an interactive composer', async ({
    glyph,
    provider,
  }) => {
    const output = await runCommand(
      glyph,
      provider,
      execute('printf "READY\\n"; sleep 60; printf bad > timeout.txt', { timeout_ms: 500 }),
    );
    expect(output.error.message).toMatch(/timeout|timed out/i);
    expect(await file(glyph, 'timeout.txt')).toBeNull();
    const call = execute('printf "CANCEL READY\\n"; sleep 60; printf bad > cancelled.txt', { timeout_ms: 60000 });
    provider.enqueue({ output: [call] });
    await glyph.send('Run until I cancel.');
    await glyph.page
      .getByRole('region', { name: 'Command approval' })
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await expect(cards(glyph).last().getByLabel('Command output')).toContainText('CANCEL READY');
    await glyph.sendButton.click();
    await finished(glyph);
    expect(await file(glyph, 'cancelled.txt')).toBeNull();
    provider.enqueue({ chunks: ['A fresh turn works.'] });
    await glyph.send('Continue.');
    await finished(glyph);
    await expect(glyph.assistantEntries.last()).toContainText('A fresh turn works.');
  });

  it('delivers input to the selected running shell and shows the resulting interactive output', async ({
    glyph,
    provider,
  }) => {
    const id = await startInteractive(glyph, provider);
    expect(await runTool(glyph, provider, write(id, 'from agent'))).toMatchObject({
      status: 'input_written',
      terminal_id: id,
    });
    await expect(cards(glyph).first().getByLabel('Command output')).toContainText('GOT:from agent');
    await runTool(glyph, provider, close(id), true);
  });

  it('respects append_newline so typing input and submitting it remain distinct operations', async ({
    glyph,
    provider,
  }) => {
    const id = await startInteractive(glyph, provider);
    await runTool(glyph, provider, write(id, 'partial', false));
    await expect(cards(glyph).first().getByLabel('Command output')).not.toContainText('GOT:');
    await runTool(glyph, provider, write(id, '', true));
    await expect(cards(glyph).first().getByLabel('Command output')).toContainText('GOT:partial');
    await runTool(glyph, provider, close(id), true);
  });

  it('reports an unknown or idle shell without starting a command or bypassing command approval', async ({
    glyph,
    provider,
  }) => {
    expect((await runTool(glyph, provider, write('unknown', 'printf bad'))).error.message).toMatch(/unknown/i);
    const { terminal_id: id } = await runCommand(
      glyph,
      provider,
      execute('printf "finished\\n"', { background: true }),
      true,
    );
    await expect(cards(glyph).nth(1)).toContainText('Exit 0');
    expect((await runTool(glyph, provider, write(id, 'printf bad > input-bypass.txt'))).error.message).toMatch(
      /only allowed while.*running/i,
    );
    expect(await file(glyph, 'input-bypass.txt')).toBeNull();
    await runTool(glyph, provider, close(id));
  });

  it('refuses to write input to a shell owned by another chat', async ({ glyph, provider }) => {
    const id = await startInteractive(glyph, provider);
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    expect((await runTool(glyph, provider, write(id, 'stolen'))).error.message).toMatch(/unknown/i);
    expect((await runTool(glyph, provider, list())).terminals).toEqual([]);
    await expect(glyph.page.locator('.glyph-shell-command[data-live="true"]')).toHaveCount(0);
  });

  it('terminates the selected shell process and its children and removes it from the live shell list', async ({
    glyph,
    provider,
  }) => {
    const { terminal_id: id } = await runCommand(
      glyph,
      provider,
      execute('sleep 60 & echo $! > child.pid; printf "CHILD READY\\n"; wait', { background: true }),
    );
    await expect.poll(() => file(glyph, 'child.pid')).not.toBeNull();
    const pid = Number((await file(glyph, 'child.pid')).trim());
    expect(await runTool(glyph, provider, close(id), true)).toMatchObject({ status: 'closed' });
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === 'ESRCH') return false;
          throw error;
        }
      })
      .toBe(false);
    expect((await runTool(glyph, provider, list())).terminals).toEqual([]);
    await expect(glyph.page.locator('.glyph-shell-command[data-live="true"]')).toHaveCount(0);
  });

  it('reports an already closed or unknown shell without affecting another running shell', async ({
    glyph,
    provider,
  }) => {
    const id = await startInteractive(glyph, provider);
    expect((await runTool(glyph, provider, close('unknown'))).error.message).toMatch(/unknown/i);
    expect((await runTool(glyph, provider, list())).terminals.map(value => value.terminal_id)).toEqual([id]);
    await runTool(glyph, provider, close(id), true);
    expect((await runTool(glyph, provider, close(id))).error.message).toMatch(/unknown/i);
  });

  it('refuses to close a shell owned by another chat', async ({ glyph, provider }) => {
    const id = await startInteractive(glyph, provider);
    await glyph.page.getByRole('button', { name: 'New chat', exact: true }).click();
    expect((await runTool(glyph, provider, close(id))).error.message).toMatch(/unknown/i);
    expect((await runTool(glyph, provider, list())).terminals).toEqual([]);
  });

  it('shows each shell owned by the current chat with its command, directory, status, and bounded recent output', async ({
    glyph,
    provider,
  }) => {
    const { terminal_id: id } = await runCommand(
      glyph,
      provider,
      execute(
        'i=0; while [ "$i" -lt 7000 ]; do printf "bounded-output\\n"; i=$((i + 1)); done; printf "TAIL END\\n"; sleep 60',
        { background: true, working_directory: 'nested' },
      ),
    );
    await expect(cards(glyph).first().getByLabel('Command output')).toContainText('TAIL END');
    const output = await runTool(glyph, provider, list());
    expect(output.terminals).toHaveLength(1);
    expect(output.terminals[0]).toMatchObject({
      terminal_id: id,
      status: 'running',
      working_directory: expect.stringContaining('/nested'),
    });
    expect(output.terminals[0].output_tail.length).toBeLessThanOrEqual(65536);
    expect(output.terminals[0].output_tail).toContain('TAIL END');
    await cards(glyph).last().getByRole('button').first().click();
    await expect(cards(glyph).last()).toContainText(id);
    await runTool(glyph, provider, close(id), true);
  });

  it('reports an empty shell list without inventing a session or showing another chat’s shells', async ({
    glyph,
    provider,
  }) => {
    expect((await runTool(glyph, provider, list())).terminals).toEqual([]);
    await expect(cards(glyph).first().getByLabel('Command output')).toHaveText('No shell sessions.');
  });

  it('reflects command completion and removes closed shells when the agent lists shells again', async ({
    glyph,
    provider,
  }) => {
    const { terminal_id: id } = await runCommand(
      glyph,
      provider,
      execute('printf "FINISHED\\n"', { background: true }),
      true,
    );
    await expect(cards(glyph).first()).toContainText('Exit 0');
    const output = await runTool(glyph, provider, list());
    expect(output.terminals[0]).toMatchObject({ terminal_id: id, status: 'idle', exit_code: 0 });
    await runTool(glyph, provider, close(id));
    expect((await runTool(glyph, provider, list())).terminals).toEqual([]);
  });

  it('lets the user send input and close a live shell from its expanded card', async ({ glyph, provider }) => {
    await startInteractive(glyph, provider);
    const card = cards(glyph).first();
    await card.getByRole('button').first().click();
    await card.getByRole('textbox', { name: 'Input to shell' }).fill('from user');
    await card.getByRole('checkbox', { name: 'Append newline' }).uncheck();
    await card.getByRole('button', { name: 'Send input' }).click();
    await expect(card.getByRole('textbox', { name: 'Input to shell' })).toHaveValue('');
    await expect(card.getByLabel('Command output')).not.toContainText('GOT:');
    await card.getByRole('checkbox', { name: 'Append newline' }).check();
    await card.getByRole('button', { name: 'Send input' }).click();
    await expect(card.getByLabel('Command output')).toContainText('GOT:from user');
    provider.enqueue({ chunks: ['Background terminal stopped.'] });
    await card.getByRole('button', { name: 'Close shell' }).click();
    await expect(card.getByRole('button', { name: 'Close shell' })).toHaveCount(0);
    await expect(glyph.assistantEntries.last()).toContainText('Background terminal stopped.');
    expect(provider.requests).toHaveLength(3);
  });
});
