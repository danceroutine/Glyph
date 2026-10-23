import { describe, expect, it, vi } from 'vitest';
import { TodoToolRuntime } from '#src/todos/TodoToolRuntime.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';

const chat = { id: 'chat', accountProvider: 'fixture', accountId: 'account' };
const item = { id: 'inspect', text: 'Inspect the code', status: TodoStatus.PENDING };

describe(TodoToolRuntime, () => {
  it('uses host ownership and returns only committed state', async () => {
    const update = vi.fn(async () => [item]);
    const runtime = new TodoToolRuntime(update);
    const signal = new AbortController().signal;
    expect(
      JSON.parse(
        await runtime.execute('update_todos', JSON.stringify({ items: [item], replace: false }), signal, { chat }),
      ),
    ).toEqual({ items: [item] });
    expect(update).toHaveBeenCalledWith(chat, { items: [item], replace: false }, signal);
    update.mockRejectedValue(new Error('Storage unavailable'));
    expect(
      JSON.parse(
        await runtime.execute('update_todos', JSON.stringify({ items: [item], replace: false }), signal, { chat }),
      ),
    ).toEqual({ error: { code: 'TODO_UPDATE_FAILED', message: 'Storage unavailable' } });
  });

  it.each([
    { items: [item, item], replace: false },
    { items: [{ ...item, status: 'done' }], replace: false },
    { items: [{ ...item, text: '  ' }], replace: false },
    { items: [{ ...item, text: 'x'.repeat(1001) }], replace: false },
    { items: Array.from({ length: 101 }, (_, i) => ({ ...item, id: String(i) })), replace: true },
    { items: [item], replace: false, chatId: 'another-chat' },
  ])('rejects invalid updates atomically: %j', async input => {
    const update = vi.fn();
    const runtime = new TodoToolRuntime(update);
    expect(JSON.parse(await runtime.execute('update_todos', JSON.stringify(input), undefined, { chat }))).toMatchObject(
      { error: { code: 'MALFORMED' } },
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects missing chat provenance and cancellation before storage', async () => {
    const update = vi.fn();
    const runtime = new TodoToolRuntime(update);
    const input = JSON.stringify({ items: [item], replace: false });
    expect(JSON.parse(await runtime.execute('update_todos', input))).toMatchObject({
      error: { code: 'TODO_UPDATE_FAILED' },
    });
    await expect(
      runtime.execute('update_todos', input, AbortSignal.abort(new Error('Stopped')), { chat }),
    ).rejects.toThrow('Stopped');
    expect(update).not.toHaveBeenCalled();
  });

  it('exposes a tool that validates its input and executes updates for the owning chat', async () => {
    const update = vi.fn(async () => [{ id: 'write', text: 'Write the tests', status: TodoStatus.PENDING }]);
    const runtime = new TodoToolRuntime(update);
    const [tool] = runtime.tools;
    const input = JSON.stringify({
      items: [{ id: 'write', text: 'Write the tests', status: TodoStatus.PENDING }],
      replace: false,
    });

    expect(() => {
      tool!.validateInput(input);
    }).not.toThrow();
    expect(() => {
      tool!.validateInput('{"items":"nope"}');
    }).toThrow();
    expect(
      JSON.parse(
        await tool!.execute(input, new AbortController().signal, {
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        }),
      ),
    ).toEqual({ items: [{ id: 'write', text: 'Write the tests', status: TodoStatus.PENDING }] });
  });

  describe(TodoToolRuntime.prototype.execute, () => {
    it('rejects tools it does not provide', async () => {
      const runtime = new TodoToolRuntime(vi.fn());

      await expect(runtime.execute('delete_todos', '{}')).rejects.toThrow('Unknown todo tool: delete_todos');
    });

    it('reports a generic failure message when storage fails with a non-error value', async () => {
      const runtime = new TodoToolRuntime(
        vi.fn(async () => {
          throw 'offline';
        }),
      );
      const input = JSON.stringify({
        items: [{ id: 'write', text: 'Write the tests', status: TodoStatus.PENDING }],
        replace: false,
      });

      expect(
        JSON.parse(
          await runtime.execute('update_todos', input, undefined, {
            chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
          }),
        ),
      ).toEqual({ error: { code: 'TODO_UPDATE_FAILED', message: 'Could not update todos.' } });
    });

    it('rethrows the storage failure when cancelled without a cancellation reason', async () => {
      const signal = { aborted: false, reason: undefined, throwIfAborted: () => {} };
      const failure = new Error('Interrupted');
      const runtime = new TodoToolRuntime(
        vi.fn(async () => {
          signal.aborted = true;
          throw failure;
        }),
      );
      const input = JSON.stringify({
        items: [{ id: 'write', text: 'Write the tests', status: TodoStatus.PENDING }],
        replace: false,
      });

      await expect(
        runtime.execute('update_todos', input, signal as unknown as AbortSignal, {
          chat: { id: 'chat', accountProvider: 'fixture', accountId: 'account' },
        }),
      ).rejects.toBe(failure);
    });
  });
});
