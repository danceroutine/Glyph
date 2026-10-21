import { describe, expect, it } from 'vitest';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { toShellCommandSummary } from '#src/shell/toShellCommandSummary.js';

const activity = {
  namespace: 'shell',
  name: 'execute_shell',
  callId: 'call',
  phase: ToolActivityPhase.COMPLETED,
  arguments: JSON.stringify({ command: 'pwd', working_directory: 'nested', background: false }),
};
describe(toShellCommandSummary, () => {
  it('retains bounded output and resolved directory with the actual exit code and failure', () => {
    const summary = toShellCommandSummary({
      ...activity,
      output: JSON.stringify({
        terminal_id: 'session',
        working_directory: '/workspace/nested',
        output: 'x'.repeat(70000) + 'last',
        exit_code: 7,
        error: { message: 'Command exited with code 7.' },
      }),
    });
    expect(summary).toMatchObject({
      command: 'pwd',
      workingDirectory: '/workspace/nested',
      sessionId: 'session',
      exitCode: 7,
      error: 'Command exited with code 7.',
    });
    expect(summary?.output).toHaveLength(65536);
    expect(summary?.output.endsWith('last')).toBe(true);
  });
  it('keeps every listed shell identifiable while bounding each recent output', () => {
    const terminals = ['first', 'second'].map(terminal_id => ({
      terminal_id,
      command: 'read line',
      working_directory: '/workspace',
      status: 'running',
      output_tail: 'x'.repeat(65536) + terminal_id,
    }));
    const summary = toShellCommandSummary({
      ...activity,
      name: 'list_shells',
      arguments: '{}',
      output: JSON.stringify({ terminals }),
    });
    expect(summary?.output).toContain('first · running');
    expect(summary?.output).toContain('second · running');
    expect(summary!.output.length).toBeLessThan(5000);
  });
  it('summarizes a started command before it reports output', () => {
    expect(toShellCommandSummary({ ...activity, phase: ToolActivityPhase.STARTED })).toEqual({
      command: 'pwd',
      output: '',
      background: false,
      workingDirectory: 'nested',
    });
  });
  it('labels lifecycle tools without a command and reports their missing output as empty', () => {
    expect(
      toShellCommandSummary({
        ...activity,
        name: 'close_shell',
        arguments: JSON.stringify({ terminal_id: 'session' }),
        output: JSON.stringify({ terminal_id: 'session' }),
      }),
    ).toEqual({ command: 'Close shell', output: '', background: false, sessionId: 'session' });
  });
  it('reports an empty shell list and the exit codes of listed shells', () => {
    const empty = toShellCommandSummary({
      ...activity,
      name: 'list_shells',
      arguments: '{}',
      output: JSON.stringify({ terminals: [] }),
    });
    const exited = toShellCommandSummary({
      ...activity,
      name: 'list_shells',
      arguments: '{}',
      output: JSON.stringify({
        terminals: [
          {
            terminal_id: 'done',
            command: 'pnpm test',
            working_directory: '/workspace',
            status: 'idle',
            output_tail: 'ok',
            exit_code: 0,
          },
        ],
      }),
    });

    expect(empty).toEqual({ command: 'List shells', output: 'No shell sessions.', background: false });
    expect(exited?.output).toBe('done · idle · Exit 0\npnpm test\n/workspace\nok');
  });
  it('does not interpret another namespace or malformed tool output as shell display data', () => {
    expect(toShellCommandSummary({ ...activity, namespace: 'untrusted' })).toBeUndefined();
    expect(toShellCommandSummary({ ...activity, output: '{' })).toBeUndefined();
  });
});
