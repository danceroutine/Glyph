import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import { ShellToolName } from '#src/shell/ShellToolName.js';
import { ShellToolNamespace } from '#src/shell/ShellToolNamespace.js';
import { ShellToolRuntime } from '#src/shell/ShellToolRuntime.js';

const context = {
  chat: { id: 'chat-one', accountProvider: 'openai', accountId: 'account-one' },
};

describe(ShellToolRuntime, () => {
  describe('definitions', () => {
    it('exposes provider-neutral strict JSON lifecycle tools', () => {
      const runtime = new ShellToolRuntime(sessions());

      expect(runtime.tools.map(definition => [definition.namespace, definition.name])).toEqual([
        [ShellToolNamespace.SHELL, ShellToolName.EXECUTE],
        [ShellToolNamespace.SHELL, ShellToolName.WRITE_INPUT],
        [ShellToolNamespace.SHELL, ShellToolName.CLOSE],
        [ShellToolNamespace.SHELL, ShellToolName.LIST],
      ]);
      expect(runtime.tools.every(definition => definition.inputKind === ToolInputKind.JSON)).toBe(true);
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

      expect(manager.writeInput).toHaveBeenNthCalledWith(1, {
        terminalId: 'terminal',
        input: 'yes',
        appendNewline: true,
        ownerChatId: 'chat-one',
        signal: expect.any(AbortSignal),
      });
      expect(manager.writeInput).toHaveBeenNthCalledWith(2, {
        terminalId: 'terminal',
        input: '',
        appendNewline: false,
        wakeOn: 'ready',
        ownerChatId: 'chat-one',
        signal: expect.any(AbortSignal),
      });
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

    it('forwards the execution ID and reports the working directory of a running command', async () => {
      const manager = sessions();
      manager.execute.mockResolvedValueOnce({
        terminalId: 'terminal',
        workingDirectory: 'packages/app',
        status: 'running',
        output: 'starting',
      });
      const runtime = new ShellToolRuntime(manager);

      const result = JSON.parse(
        await runtime.execute(
          ShellToolName.EXECUTE,
          JSON.stringify({
            command: 'pnpm dev',
            terminal_id: null,
            working_directory: null,
            background: true,
            wake_on: null,
            timeout_ms: null,
          }),
          undefined,
          { ...context, executionId: 'execution-1' },
        ),
      ) as Record<string, unknown>;

      expect(result).toEqual({
        terminal_id: 'terminal',
        working_directory: 'packages/app',
        status: 'running',
        output: 'starting',
      });
      expect(manager.execute).toHaveBeenCalledWith('pnpm dev', expect.objectContaining({ executionId: 'execution-1' }));
    });

    it('lists terminal ownership, exit codes, and wake conditions when known', async () => {
      const manager = sessions();
      vi.mocked(manager.sessionsFor).mockReturnValueOnce([
        {
          id: 'finished',
          ownerChatId: 'chat-one',
          workingDirectory: '.',
          command: 'pnpm test',
          status: ShellSessionStatus.EXITED,
          background: true,
          outputTail: 'ok',
          startedAt: '2026-01-01T00:00:00.000Z',
          exitCode: 0,
          wakePattern: 'done',
        },
        {
          id: 'unowned',
          workingDirectory: '.',
          command: 'pnpm dev',
          status: ShellSessionStatus.RUNNING,
          background: true,
          outputTail: '',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      const runtime = new ShellToolRuntime(manager);

      expect(JSON.parse(await runtime.execute(ShellToolName.LIST, '{}', undefined, context))).toEqual({
        terminals: [
          {
            terminal_id: 'finished',
            owner_chat_id: 'chat-one',
            working_directory: '.',
            command: 'pnpm test',
            status: 'exited',
            output_tail: 'ok',
            started_at: '2026-01-01T00:00:00.000Z',
            exit_code: 0,
            wake_on: 'done',
          },
          {
            terminal_id: 'unowned',
            working_directory: '.',
            command: 'pnpm dev',
            status: 'running',
            output_tail: '',
            started_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
      expect(manager.sessionsFor).toHaveBeenCalledWith('chat-one');
    });

    it('reports a generic failure message for non-error failures', async () => {
      const manager = sessions();
      manager.close.mockRejectedValueOnce('closed already');
      const runtime = new ShellToolRuntime(manager);

      expect(
        JSON.parse(
          await runtime.execute(ShellToolName.CLOSE, JSON.stringify({ terminal_id: 'terminal' }), undefined, context),
        ),
      ).toEqual({ error: { code: 'SHELL_FAILED', message: 'Shell operation failed.' } });
    });

    it('rethrows the failure when cancelled without a cancellation reason', async () => {
      const manager = sessions();
      const signal = { aborted: false, reason: undefined };
      const failure = new Error('interrupted');
      manager.close.mockImplementationOnce(async () => {
        signal.aborted = true;
        throw failure;
      });
      const runtime = new ShellToolRuntime(manager);

      await expect(
        runtime.execute(
          ShellToolName.CLOSE,
          JSON.stringify({ terminal_id: 'terminal' }),
          signal as unknown as AbortSignal,
          context,
        ),
      ).rejects.toBe(failure);
    });
  });

  describe('tools', () => {
    it.each([
      [
        ShellToolName.EXECUTE,
        JSON.stringify({
          command: 'ls',
          terminal_id: null,
          working_directory: null,
          background: false,
          wake_on: null,
          timeout_ms: null,
        }),
        { terminal_id: 'terminal', status: 'completed', output: '', exit_code: 0 },
      ],
      [
        ShellToolName.WRITE_INPUT,
        JSON.stringify({ terminal_id: 'terminal', input: 'y', append_newline: true, wake_on: null }),
        { terminal_id: 'terminal', status: 'input_written' },
      ],
      [ShellToolName.CLOSE, JSON.stringify({ terminal_id: 'terminal' }), { terminal_id: 'terminal', status: 'closed' }],
      [ShellToolName.LIST, '{}', { terminals: [{ terminal_id: 'terminal' }] }],
    ])('validates and executes %s through its tool definition', async (name, input, expected) => {
      const tool = new ShellToolRuntime(sessions()).tools.find(definition => definition.name === (name as string))!;

      expect(() => {
        tool.validateInput(input);
      }).not.toThrow();
      expect(() => {
        tool.validateInput('{"unexpected":true}');
      }).toThrow();
      expect(JSON.parse(await tool.execute(input, new AbortController().signal, context))).toEqual(expected);
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
    execute: Mock;
    writeInput: Mock;
    close: Mock;
  };
}
