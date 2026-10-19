import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test as it } from './GlyphWorkbench.fixture.mjs';
import { ScriptedProvider } from './ScriptedProvider.mjs';

it.describe('Scripted provider through the production desktop runtime', () => {
  it.use({ scriptedProvider: true });

  it('executes a scripted tool call through editor RPC and returns its real result to the provider', async ({
    glyph,
    provider,
  }) => {
    const evidence = `Local fixture ${randomUUID()} — café 🌱`;
    await writeFile(join(glyph.workspace, 'provider-proof.txt'), evidence + '\n');
    provider.enqueue(
      {
        output: [
          ScriptedProvider.tool('read_project_file', { path: 'provider-proof.txt', start_line: null, end_line: null }),
        ],
      },
      { chunks: ['The production tool loop returned the file.'] },
    );
    await glyph.send('Read provider-proof.txt.');
    await expect(glyph.assistantEntries.locator('[data-glyph-source]')).toHaveText([
      'The production tool loop returned the file.',
    ]);
    await expect(glyph.sendButton).toHaveText('Send (⌘/Ctrl+Enter)');
    await expect(glyph.diagnostics).toHaveCount(0);
    expect(provider.requests).toHaveLength(2);
    const input = provider.requests[1].body.input;
    expect(input.filter(item => item.type === 'function_call' && item.call_id === 'fixture-call')).toHaveLength(1);
    const results = input.filter(item => item.type === 'function_call_output' && item.call_id === 'fixture-call');
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].output)).toMatchObject({
      path: 'provider-proof.txt',
      lines: [
        { number: 1, content: evidence, lineEnding: '\n' },
        { number: 2, content: '', lineEnding: '' },
      ],
    });
  });
});
