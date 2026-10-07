import { describe, expect, it, vi } from 'vitest';
import type { ShellSessionManager } from '../ShellSessionManager.ts';
import { ShellToolName } from '../ShellToolName.ts';
import { ShellToolNamespace } from '../ShellToolNamespace.ts';
import { ShellToolRuntime } from '../ShellToolRuntime.ts';

const context = {
  chat: { id: 'chat-one', accountProvider: 'openai', accountId: 'account-one' },
};

describe(ShellToolRuntime, () => {
  describe('definitions', () => {
    it('exposes provider-neutral strict JSON lifecycle tools', () => {
      const runtime = new ShellToolRuntime(sessions());

      expect(runtime.definitions.map(definition => [definition.namespace, definition.name])).toEqual([
        [ShellToolNamespace.SHELL, ShellToolName.EXECUTE],
        [ShellToolNamespace.SHELL, ShellToolName.WRITE_INPUT],
        [ShellToolNamespace.SHELL, ShellToolName.CLOSE],
        [ShellToolNamespace.SHELL, ShellToolName.LIST],
      ]);
      expect(runtime.definitions.every(definition => definition.inputKind === 'JSON')).toBe(true);
    });
  });

  describe(ShellToolRuntime.prototype.execute, () => {
    it('executes new and existing terminals with normalized nullable options', async () => {
      const manager = sessions();
      const runtime = new ShellToolRuntime(manager);
      const signal = new AbortController().signal;

      await runtime.execute(
        ShellToolName.EXECUTE,
        JSON.stringify({
          command: 'pnpm test',
          terminal_id: null,
          working_directory: null,
          background: true,
          wake_on: null,
          timeout_ms: null,
        }),
        signal,
        context,
      );
      await runtime.execute(
        ShellToolName.EXECUTE,
        JSON.stringify({
          command: 'pnpm test',
          terminal_id: 'terminal',
          working_directory: 'packages/app',
          background: false,
          wake_on: 'passed',
          timeout_ms: 500,
        }),
        signal,
        context,
      );

      expect(manager.execute).toHaveBeenNthCalledWith(1, 'pnpm test', {
        background: true,
        signal,
        ownerChatId: 'chat-one',
      });
      expect(manager.execute).toHaveBeenNthCalledWith(2, 'pnpm test', {
        terminalId: 'terminal',
        workingDirectory: 'packages/app',
        background: false,
        wakeOn: 'passed',
        timeoutMs: 500,
        signal,
        ownerChatId: 'chat-one',
      });
    });

    it('reports non-zero command exits as tool failures without dropping output', async () => {
      const manager = sessions();
      manager.execute.mockResolvedValueOnce({
        terminalId: 'terminal',
        status: 'completed',
        output: 'failed output',
        exitCode: 7,
      });
      const runtime = new ShellToolRuntime(manager);

      const result = JSON.parse(
        await runtime.execute(
          ShellToolName.EXECUTE,
          JSON.stringify({
            command: 'exit 7',
            terminal_id: null,
            working_directory: null,
            background: false,
            wake_on: null,
            timeout_ms: null,
          }),
          undefined,
          context,
        ),
      ) as Record<string, unknown>;

      expect(result).toEqual({
        terminal_id: 'terminal',
        status: 'completed',
        output: 'failed output',
        exit_code: 7,
        error: { code: 'COMMAND_EXITED', message: 'Shell command exited with code 7.' },
      });
    });

    it('writes input, closes, and lists terminals', async () => {
      const manager = sessions();
      const runtime = new ShellToolRuntime(manager);

      await expect(
        runtime.execute(
          ShellToolName.WRITE_INPUT,
          JSON.stringify({ terminal_id: 'terminal', input: 'yes', append_newline: true, wake_on: null }),
          undefined,
          context,
        ),
      ).resolves.toContain('input_written');
      await runtime.execute(
        ShellToolName.WRITE_INPUT,
        JSON.stringify({ terminal_id: 'terminal', input: '', append_newline: false, wake_on: 'ready' }),
        undefined,
        context,
      );
      await expect(
        runtime.execute(ShellToolName.CLOSE, JSON.stringify({ terminal_id: 'terminal' }), undefined, context),
      ).resolves.toContain('closed');
      await expect(runtime.execute(ShellToolName.LIST, '{}', undefined, context)).resolves.toContain('terminal');

      expect(manager.writeInput).toHaveBeenNthCalledWith(1, 'terminal', 'yes', true, undefined, 'chat-one');
      expect(manager.writeInput).toHaveBeenNthCalledWith(2, 'terminal', '', false, 'ready', 'chat-one');
      expect(manager.close).toHaveBeenCalledWith('terminal', 'chat-one');
    });

    it('returns structured malformed and runtime failures but preserves cancellation', async () => {
      const manager = sessions();
      const runtime = new ShellToolRuntime(manager);
      const malformed = JSON.parse(await runtime.execute(ShellToolName.EXECUTE, '{}', undefined, context)) as {
        error: { code: string };
      };
      const unknown = JSON.parse(await runtime.execute('missing', '{}', undefined, context)) as {
        error: { code: string };
      };
      manager.close.mockRejectedValueOnce(new Error('close failed'));
      const failed = JSON.parse(
        await runtime.execute(ShellToolName.CLOSE, JSON.stringify({ terminal_id: 'terminal' }), undefined, context),
      ) as { error: { code: string; message: string } };
      const cancellation = new AbortController();
      cancellation.abort(new Error('cancelled'));

      expect(malformed.error.code).toBe('MALFORMED');
      expect(unknown.error.code).toBe('SHELL_FAILED');
      expect(failed.error).toEqual({ code: 'SHELL_FAILED', message: 'close failed' });
      await expect(runtime.execute(ShellToolName.LIST, '{', cancellation.signal, context)).rejects.toThrow('cancelled');
      await expect(runtime.execute(ShellToolName.LIST, '{}')).resolves.toContain('owning chat');
    });
  });
});

function sessions() {
  return {
    sessionsFor: vi.fn(() => [{ id: 'terminal' }]),
    execute: vi.fn(async () => ({ terminalId: 'terminal', status: 'completed', output: '', exitCode: 0 })),
    writeInput: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as ShellSessionManager & {
    execute: ReturnType<typeof vi.fn>;
    writeInput: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}
