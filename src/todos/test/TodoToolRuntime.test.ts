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
    { items: [{ ...item, text: 'x'.repeat(501) }], replace: false },
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
});
