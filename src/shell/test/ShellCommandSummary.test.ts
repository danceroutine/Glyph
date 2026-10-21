import { describe, expect, it } from 'vitest';
import { shellCommandSummarySchema } from '#src/shell/ShellCommandSummary.js';

describe('shellCommandSummarySchema', () => {
  it('omits absent optional fields', () => {
    expect(shellCommandSummarySchema.parse({ command: 'ls', output: '', background: false })).toEqual({
      command: 'ls',
      output: '',
      background: false,
    });
  });

  it('keeps every supplied field', () => {
    const summary = {
      command: 'pnpm test',
      output: 'failed',
      background: true,
      workingDirectory: '/workspace',
      sessionId: 'session',
      exitCode: 1,
      error: 'Command exited with code 1.',
    };

    expect(shellCommandSummarySchema.parse(summary)).toEqual(summary);
  });
});
