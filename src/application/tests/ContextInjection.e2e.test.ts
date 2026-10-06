import { describe, expect, it } from 'vitest';
import { EditingE2EHarness } from './fixtures/EditingE2EHarness.ts';

describe(EditingE2EHarness, () => {
  describe(EditingE2EHarness.prototype.send, () => {
    it('resolves selected files at send time and includes only their exact snapshots', async () => {
      const harness = await EditingE2EHarness.create(
        {
          'src/App.tsx': 'export const message = "attached";\n',
          'src/unselected.ts': 'export const secret = "not attached";\n',
        },
        [
          {
            id: 'response-context',
            output: [EditingE2EHarness.finalMessage('I used the attached file.')],
            validate: request => {
              const input = request.input as Array<{
                role: string;
                content: Array<{ type: string; text: string }>;
              }>;
              expect(input).toHaveLength(1);
              expect(input[0]?.role).toBe('user');
              expect(input[0]?.content[1]).toEqual({
                type: 'input_text',
                text: 'Explain the selected component.',
              });
              expect(JSON.parse(input[0]!.content[0]!.text)).toEqual({
                schema: 'glyph.workspace-context.v1',
                files: [
                  {
                    path: 'src/App.tsx',
                    revision: expect.any(String),
                    byteOrderMark: false,
                    text: 'export const message = "attached";\n',
                  },
                ],
              });
            },
          },
        ],
      );

      try {
        await expect(harness.send('Explain the selected component.', ['src/App.tsx'])).resolves.toBe(
          'I used the attached file.',
        );
      } finally {
        await harness.dispose();
      }
    });
  });
});
