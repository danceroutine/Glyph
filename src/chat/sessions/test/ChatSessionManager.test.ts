import { AgentModeID } from '#src/chat/AgentMode.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextResolver } from '#src/project/context/ProjectContextResolver.js';
import { ChatConversation } from '#src/chat/ChatConversation.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ChatRequestInput } from '#src/chat/ChatRequest.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { TurnResult } from '#src/chat/TurnResult.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatSessionStore } from '#src/chat/sessions/ChatSessionStore.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';
import { GoalError } from '#src/goals/GoalError.js';
import { GoalPauseReason } from '#src/goals/GoalPauseReason.js';
import { GoalStatus } from '#src/goals/GoalStatus.js';
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ChatSessionManager, () => {
  it('branches at an answer and restores before a prompt without retaining future provider history', async () => {
    const store = new MemoryChatSessionStore();
    const context = await ProjectContextResolver.folder(await projectFixture());
    const manager = new ChatSessionManager(store, context);
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const send = (text: string) =>
      session.send({ text, attachments: [], turnId: text }, { push: () => {} }, new AbortController().signal);
    await send('first');
    await send('second');
    await send('third');
    const fork = await manager.branch(session, 'first', record => conversation(record.providerState));
    await fork.send('branch follow-up', { push: () => {} }, new AbortController().signal);
    expect(providerMessages(store.records.find(record => record.id === fork.id)!)).toEqual([
      'first',
      'branch follow-up',
    ]);
    expect(session.transcript.map(turn => turn.userText)).toEqual(['first', 'second', 'third']);
    await session.restoreCheckpoint('second');
    expect(session.transcript.map(turn => turn.userText)).toEqual(['first']);
    await send('replacement');
    expect(providerMessages(store.records.find(record => record.id === session.id)!)).toEqual(['first', 'replacement']);
    await expect(session.restoreCheckpoint('third')).rejects.toThrow('no longer');
    const reopened = new ChatSessionManager(store, context);
    await reopened.initialize();
    const restored = reopened.open(session.id, record => conversation(record.providerState));
    await restored.restoreCheckpoint('first');
    expect(restored.transcript).toEqual([]);
    expect(providerMessages(store.records.find(record => record.id === session.id)!)).toEqual([]);
    expect(fork.transcript).toHaveLength(2);
  });

  it('rolls back a failed restore in both storage and the live provider', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    await session.send(
      { text: 'first', attachments: [], turnId: 'first' },
      { push: () => {} },
      new AbortController().signal,
    );
    store.failure = new Error('Disk full');
    await expect(session.restoreCheckpoint('first')).rejects.toThrow('Disk full');
    expect(session.transcript).toHaveLength(1);
    store.failure = undefined;
    await session.send('second', { push: () => {} }, new AbortController().signal);
    expect(providerMessages(store.records[0]!)).toEqual(['first', 'second']);
  });

  it('keeps immutable plan revisions, rejects stale edits and links another chat without executing it', async () => {
    const store = new MemoryChatSessionStore();
    const context = await ProjectContextResolver.folder(await projectFixture());
    const manager = new ChatSessionManager(store, context);
    await manager.initialize();
    const first = await manager.create(input(), conversation());
    const second = await manager.create(input(), conversation());
    const update = {
      id: null,
      expectedRevision: null,
      title: 'Plan',
      summary: 'Review before build',
      markdown: '# Plan',
      todos: [],
    };
    const owner = { id: first.id, accountProvider: 'fixture', accountId: 'account' };
    const created = (await manager.updatePlan(owner, update)).plans![0]!;
    const revised = await manager.updatePlan(owner, {
      ...update,
      id: created.id,
      expectedRevision: 1,
      markdown: '# Revised plan',
    });
    expect(revised.plans).toHaveLength(2);
    expect(revised.plans![0]!.markdown).toBe('# Plan');
    await expect(manager.updatePlan(owner, { ...update, id: created.id, expectedRevision: 1 })).rejects.toThrow(
      'changed',
    );
    const linked = await manager.linkPlan(first.id, created.id, second.id, 'Reviewer');
    expect(linked.plans!.at(-1)!.agents).toEqual([
      { chatId: first.id, role: 'Author' },
      { chatId: second.id, role: 'Reviewer' },
    ]);
    expect(second.transcript).toEqual([]);
    await manager.setMode(second.id, AgentModeID.PLAN);
    expect(second.summary.mode).toBe('plan');
    await manager.dispose();
  });

  it('merges stable todo IDs without losing concurrent checkpoints or another chat’s list', async () => {
    const store = new MemoryChatSessionStore();
    const context = await ProjectContextResolver.folder(await projectFixture());
    const manager = new ChatSessionManager(store, context);
    await manager.initialize();
    const first = await manager.create(input(), conversation());
    const second = await manager.create(input(), conversation());
    const owner = { id: first.id, accountProvider: 'fixture', accountId: 'account' };
    const items = [
      { id: 'a', text: 'First', status: TodoStatus.PENDING },
      { id: 'b', text: 'Second', status: TodoStatus.IN_PROGRESS },
    ];
    await manager.updateTodos(owner, { items, replace: true });
    const completed = { ...items[0]!, status: TodoStatus.COMPLETED };
    await Promise.all([
      first.send('Continue', { push: () => {} }, new AbortController().signal),
      manager.updateTodos(owner, { items: [completed], replace: false }),
      manager.updateTodos(
        { ...owner, id: second.id },
        { items: [{ ...items[0]!, text: 'Other chat' }], replace: true },
      ),
    ]);
    await manager.updateTodos(owner, { items: [completed], replace: false });
    expect(first.summary.todos).toEqual([completed, items[1]]);
    expect(first.transcript).toHaveLength(1);
    expect(second.summary.todos).toEqual([{ ...items[0], text: 'Other chat' }]);
    const restored = new ChatSessionManager(store, context);
    await restored.initialize();
    expect(restored.list().find(chat => chat.id === first.id)?.todos).toEqual([completed, items[1]]);
    await manager.updateTodos(owner, { items: [], replace: true });
    expect(first.summary.todos).toEqual([]);
    expect(second.summary.todos).toHaveLength(1);
  });

  it('preserves the last durable todo list on storage failure, cancellation, or wrong account', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const owner = { id: session.id, accountProvider: 'fixture', accountId: 'account' };
    const item = { id: 'a', text: 'Pending work', status: TodoStatus.PENDING };
    await manager.updateTodos(owner, { items: [item], replace: false });
    store.failure = new Error('Disk full');
    await expect(manager.updateTodos(owner, { items: [], replace: true })).rejects.toThrow('Disk full');
    expect(session.summary.todos).toEqual([item]);
    store.failure = undefined;
    await expect(
      manager.updateTodos(owner, { items: [], replace: true }, AbortSignal.abort(new Error('Cancelled'))),
    ).rejects.toThrow('Cancelled');
    await expect(manager.updateTodos({ ...owner, accountId: 'other' }, { items: [], replace: true })).rejects.toThrow(
      'requesting chat account',
    );
    expect(session.summary.todos).toEqual([item]);
    await session.send('tool then fail', { push: () => {} }, new AbortController().signal).catch(() => {});
    expect(session.summary.todos).toEqual([item]);
    await manager.updateTodos(owner, { items: [{ ...item, status: TodoStatus.COMPLETED }], replace: false });
    expect(session.summary.todos?.[0]?.status).toBe(TodoStatus.COMPLETED);
  });

  it('arms one durable goal per chat and replaces it only after it is cleared or complete', async () => {
    const store = new MemoryChatSessionStore();
    const context = await ProjectContextResolver.folder(await projectFixture());
    const manager = new ChatSessionManager(store, context);
    await manager.initialize();
    const first = await manager.create(input(), conversation());
    const second = await manager.create(input(), conversation());
    const owner = { id: first.id, accountProvider: 'fixture', accountId: 'account' };

    const created = await manager.createGoal(owner, '  Make CI green  ');

    expect(created.goal).toMatchObject({ objective: 'Make CI green', status: GoalStatus.ACTIVE });
    expect(second.summary.goal).toBeUndefined();
    await expect(manager.createGoal(owner, 'Another objective')).rejects.toThrow('already has a goal');
    const restored = new ChatSessionManager(store, context);
    await restored.initialize();
    expect(restored.list().find(chat => chat.id === first.id)?.goal).toEqual(created.goal);
    await manager.updateGoal(owner, goal => goal.complete(new Date()));
    expect((await manager.createGoal(owner, 'Next objective')).goal?.objective).toBe('Next objective');
    expect((await manager.clearGoal(owner)).goal).toBeUndefined();
    expect(first.summary.goal).toBeUndefined();
  });

  it('titles an untitled chat from its goal objective but keeps an existing title', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const untitled = await manager.create(input(), conversation());
    const titled = await manager.create(input(), conversation());
    await manager.rename(titled.id, 'Release checklist');

    await manager.createGoal(
      { id: untitled.id, accountProvider: 'fixture', accountId: 'account' },
      'Make CI green again',
    );
    await manager.createGoal(
      { id: titled.id, accountProvider: 'fixture', accountId: 'account' },
      'Make CI green again',
    );

    expect(untitled.summary).toMatchObject({ title: 'Make CI Green Again', titleOrigin: 'generated' });
    expect(titled.summary).toMatchObject({ title: 'Release checklist', titleOrigin: 'human' });
  });

  it('keeps the durable goal when an update is refused, cancelled, or for another account', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const owner = { id: session.id, accountProvider: 'fixture', accountId: 'account' };
    const { goal } = await manager.createGoal(owner, 'Make CI green');

    await expect(manager.updateGoal(owner, value => value.resume(new Date()))).rejects.toThrow(GoalError);
    await expect(
      manager.updateGoal(owner, value => value.pause(GoalPauseReason.USER, new Date()), AbortSignal.abort()),
    ).rejects.toThrow();
    await expect(manager.updateGoal({ ...owner, accountId: 'other' }, value => value)).rejects.toThrow(
      'requesting chat account',
    );
    await expect(manager.clearGoal({ ...owner, accountId: 'other' })).rejects.toThrow('requesting chat account');
    store.failure = new Error('Disk full');
    await expect(manager.clearGoal(owner)).rejects.toThrow('Disk full');
    store.failure = undefined;

    expect(session.summary.goal).toEqual(goal);
  });

  it('skips persistence when a goal update or clear changes nothing', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const owner = { id: session.id, accountProvider: 'fixture', accountId: 'account' };
    const calls = store.saveCalls;

    expect((await manager.clearGoal(owner)).goal).toBeUndefined();
    await expect(manager.updateGoal(owner, value => value)).rejects.toThrow('This chat has no goal.');
    await manager.createGoal(owner, 'Make CI green');
    await manager.updateGoal(owner, value => value);

    expect(store.saveCalls).toBe(calls + 1);
  });

  it('does not carry a goal into a branched chat', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    await session.send(
      { text: 'first', attachments: [], turnId: 'first' },
      { push: () => {} },
      new AbortController().signal,
    );
    await manager.createGoal({ id: session.id, accountProvider: 'fixture', accountId: 'account' }, 'Make CI green');

    const fork = await manager.branch(session, 'first', record => conversation(record.providerState));

    expect(fork.summary.goal).toBeUndefined();
    expect(session.summary.goal?.objective).toBe('Make CI green');
  });

  it('bounds the merged todo list before persistence', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const owner = { id: session.id, accountProvider: 'fixture', accountId: 'account' };
    const items = Array.from({ length: 100 }, (_, id) => ({
      id: String(id),
      text: 'Task',
      status: TodoStatus.PENDING,
    }));
    await manager.updateTodos(owner, { items, replace: true });
    const calls = store.saveCalls;
    await expect(
      manager.updateTodos(owner, { items: [{ ...items[0]!, id: 'extra' }], replace: false }),
    ).rejects.toThrow();
    expect(store.saveCalls).toBe(calls);
    expect(session.summary.todos).toEqual(items);
  });

  it.each(['send', 'context', 'reset'] as const)(
    'preserves a human title longer than four words across a %s checkpoint and reload',
    async operation => {
      const store = new MemoryChatSessionStore();
      const context = await ProjectContextResolver.folder(await projectFixture());
      const manager = new ChatSessionManager(store, context);
      await manager.initialize();
      const session = await manager.create(input(), conversation());
      const title = 'Investigate the desktop account refresh race carefully';
      await manager.rename(session.id, title);
      switch (operation) {
        case 'send':
          await session.send('Continue investigating', { push: () => {} }, new AbortController().signal);
          break;
        case 'context':
          await session.recordContext([
            { schemaVersion: 1, id: 'review-title-context', type: 'edit_review_result', payload: {} },
          ]);
          break;
        case 'reset':
          await session.reset();
          break;
      }
      const reloaded = new ChatSessionManager(store, context);
      await reloaded.initialize();
      expect(reloaded.list()[0]).toMatchObject({ title, titleOrigin: 'human' });
    },
  );

  it('automatically isolates chats by the project context active when the manager is created', async () => {
    const store = new MemoryChatSessionStore();
    const first = new ChatSessionManager(
      store,
      await ProjectContextResolver.folder(await projectFixture()),
      sequentialIds(),
    );
    await first.initialize();
    await first.create(input(), conversation());

    const second = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await second.initialize();

    expect(first.list()).toHaveLength(1);
    expect(second.list()).toEqual([]);
    expect(store.records[0]?.projectContextId).toBe(first.projectContext.id);
  });

  it('names the first completed turn, checkpoints provider context, resumes by short ID, and allows renaming', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(
      store,
      await ProjectContextResolver.folder(await projectFixture()),
      () => 'chat-12345678',
      fixedClock(),
    );
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    const parts: string[] = [];

    await session.send(
      'Please fix the authentication race condition in login',
      {
        push: part => {
          if (part.type === ChatResponsePartType.TEXT) parts.push(part.value);
        },
      },
      new AbortController().signal,
    );

    expect(session.summary).toMatchObject({ title: 'Fix Authentication Race Condition', turnCount: 1 });
    expect(session.transcript).toEqual([
      expect.objectContaining({
        userText: 'Please fix the authentication race condition in login',
        assistantText: 'answer',
        reasoningSummary: 'thinking',
      }),
    ]);
    expect(parts).toEqual(['answer']);

    const resumed = manager.open('chat-12', record => conversation(record.providerState));
    await resumed.send('Follow up', { push: () => {} }, new AbortController().signal);
    expect(resumed.summary.turnCount).toBe(2);
    expect(providerMessages(store.records[0]!)).toEqual([
      'Please fix the authentication race condition in login',
      'Follow up',
    ]);

    await expect(manager.rename('chat-12', '  Login concurrency fix  ')).resolves.toMatchObject({
      title: 'Login concurrency fix',
      titleOrigin: 'human',
    });
    await resumed.reset();
    await resumed.send('A new first turn after reset', { push: () => {} }, new AbortController().signal);
    expect(resumed.summary).toMatchObject({ title: 'Login concurrency fix', titleOrigin: 'human', turnCount: 1 });
    await expect(manager.rename('chat-12', '   ')).rejects.toThrow('cannot be empty');
    await expect(manager.rename('chat-12', 'x'.repeat(81))).rejects.toThrow('at most 80');
  });

  it('does not overwrite a human title set before the first turn', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
      () => 'chat-before-first-turn',
    );
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    await manager.rename(session.id, 'Human title');

    await session.send('Please invent another title', { push: () => {} }, new AbortController().signal);

    expect(session.summary).toMatchObject({ title: 'Human title', titleOrigin: 'human' });
  });

  it('rolls provider history back when a completed turn cannot be persisted', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    store.failure = new Error('disk full');

    await expect(session.send('discard me', { push: () => {} }, new AbortController().signal)).rejects.toThrow(
      'disk full',
    );
    store.failure = undefined;
    await session.send('keep me', { push: () => {} }, new AbortController().signal);

    expect(providerMessages(store.records[0]!)).toEqual(['keep me']);
    expect(session.transcript).toEqual([expect.objectContaining({ userText: 'keep me' })]);
  });

  it('retains a durable tool checkpoint when a later provider round fails', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());

    await expect(session.send('tool then fail', { push: () => {} }, new AbortController().signal)).rejects.toThrow(
      'provider failed after tool execution',
    );

    expect(providerMessages(store.records[0]!)).toEqual(['tool then fail', 'tool-result:mutation-complete']);
    expect(session.transcript).toEqual([]);
  });

  it('preserves completed tool state in memory and blocks continuation until persistence recovers', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    store.failOnSaveCall = store.saveCalls + 2;

    await expect(
      session.send('tool outcome checkpoint fails', { push: () => {} }, new AbortController().signal),
    ).rejects.toThrow('checkpoint unavailable');
    expect(providerMessages(store.records[0]!)).toEqual(['tool outcome checkpoint fails', 'tool-intent:mutation']);
    await expect(session.send('must remain blocked', { push: () => {} }, new AbortController().signal)).rejects.toThrow(
      'checkpoint unavailable',
    );

    store.failure = undefined;
    await session.send('continue after recovery', { push: () => {} }, new AbortController().signal);

    expect(providerMessages(store.records[0]!)).toEqual([
      'tool outcome checkpoint fails',
      'tool-intent:mutation',
      'tool-result:mutation-complete',
      'continue after recovery',
    ]);
    expect(session.transcript).toEqual([expect.objectContaining({ userText: 'continue after recovery' })]);
  });

  it('checkpoints host context without changing the visible transcript and rolls it back on failure', async () => {
    const store = new MemoryChatSessionStore();
    const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));
    await manager.initialize();
    const session = await manager.create(input(), conversation());
    await session.send('first turn', { push: () => {} }, new AbortController().signal);
    const event = { schemaVersion: 1 as const, id: 'review-result-1', type: 'edit_review_result', payload: {} };

    await session.recordContext([event]);

    expect(session.transcript).toEqual([expect.objectContaining({ userText: 'first turn' })]);
    expect(providerMessages(store.records[0]!)).toEqual(['first turn', 'context:review-result-1']);

    store.failure = new Error('disk full');
    await expect(
      session.recordContext([{ schemaVersion: 1, id: 'review-result-2', type: 'edit_review_result', payload: {} }]),
    ).rejects.toThrow('disk full');
    store.failure = undefined;

    await session.send('second turn', { push: () => {} }, new AbortController().signal);
    expect(providerMessages(store.records[0]!)).toEqual(['first turn', 'context:review-result-1', 'second turn']);
  });

  it('rejects unknown and ambiguous identifiers and requires initialization', async () => {
    const context = await ProjectContextResolver.folder(await projectFixture());
    const uninitialized = new ChatSessionManager(new MemoryChatSessionStore(), context);
    expect(() => uninitialized.list()).toThrow('not been initialized');
    const manager = new ChatSessionManager(new MemoryChatSessionStore(), context, sequentialIds('same-prefix-'));
    await manager.initialize();
    await manager.create(input(), conversation());
    await manager.create(input(), conversation());

    expect(() => manager.open('missing', () => conversation())).toThrow('No chat');
    expect(() => manager.open('same-prefix-', () => conversation())).toThrow('ambiguous');
  });

  describe(ChatSessionManager.prototype.initialize, () => {
    it('loads saved chats only once', async () => {
      const store = new MemoryChatSessionStore();
      const load = vi.spyOn(store, 'load');
      const manager = new ChatSessionManager(store, await ProjectContextResolver.folder(await projectFixture()));

      await manager.initialize();
      await manager.initialize();

      expect(load).toHaveBeenCalledOnce();
    });
  });

  describe(ChatSessionManager.prototype.list, () => {
    it('lists only chats owned by the requested account', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
        sequentialIds(),
      );
      await manager.initialize();
      await manager.create(input(), conversation());
      await manager.create({ ...input(), accountId: 'other-account' }, conversation());
      await manager.create({ ...input(), accountProvider: 'other-provider' }, conversation());

      expect(manager.list({ provider: 'fixture', id: 'account' }).map(chat => chat.id)).toEqual(['chat-1']);
      expect(manager.list()).toHaveLength(3);
    });
  });

  describe(ChatSessionManager.prototype.branch, () => {
    it('rejects branching at a turn without a saved checkpoint', async () => {
      const store = new MemoryChatSessionStore();
      const context = await ProjectContextResolver.folder(await projectFixture());
      store.records = [
        {
          schemaVersion: 3,
          id: 'legacy',
          title: 'Legacy',
          titleOrigin: 'human',
          projectContextId: context.id,
          accountProvider: 'fixture',
          accountId: 'account',
          modelSlug: 'model',
          modelName: 'Model',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          providerState: { provider: 'test', version: 1, data: { messages: [] } },
          transcript: [
            {
              userText: 'old',
              attachmentPaths: [],
              assistantText: 'reply',
              reasoningSummary: '',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        },
      ];
      const manager = new ChatSessionManager(store, context);
      await manager.initialize();
      const session = manager.open('legacy', record => conversation(record.providerState));

      await expect(manager.branch(session, 'legacy:history:0', () => conversation())).rejects.toThrow(
        'This message has no saved checkpoint.',
      );
    });
  });

  describe(ChatSessionManager.prototype.setMode, () => {
    it('rejects unknown modes', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const session = await manager.create(input(), conversation());

      await expect(manager.setMode(session.id, 'chaos' as AgentModeID)).rejects.toThrow('Unknown conversation mode.');
    });

    it('rejects chats that no longer exist', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();

      await expect(manager.setMode('missing', AgentModeID.PLAN)).rejects.toThrow('Chat "missing" no longer exists.');
    });
  });

  describe(ChatSessionManager.prototype.updatePlan, () => {
    it('rejects plans from another account', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const session = await manager.create(input(), conversation());

      await expect(
        manager.updatePlan(
          { id: session.id, accountProvider: 'fixture', accountId: 'intruder' },
          { id: null, expectedRevision: null, title: 'Plan', summary: 'Summary', markdown: '# Plan', todos: [] },
        ),
      ).rejects.toThrow('The plan must belong to the requesting chat.');
    });

    it('rejects plans once the chat holds one hundred revisions', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const session = await manager.create(input(), conversation());
      const owner = { id: session.id, accountProvider: 'fixture', accountId: 'account' };
      const update = {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
      };
      for (let index = 0; index < 100; index++) await manager.updatePlan(owner, update);

      await expect(manager.updatePlan(owner, update)).rejects.toThrow(
        'This chat has reached its saved plan revision limit.',
      );
    });

    it('cancels before reading the chat', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();

      await expect(
        manager.updatePlan(
          { id: 'missing', accountProvider: 'fixture', accountId: 'account' },
          { id: null, expectedRevision: null, title: 'Plan', summary: 'Summary', markdown: '# Plan', todos: [] },
          AbortSignal.abort(new Error('Cancelled')),
        ),
      ).rejects.toThrow('Cancelled');
    });
  });

  describe(ChatSessionManager.prototype.linkPlan, () => {
    it('rejects linking chats from different accounts', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const first = await manager.create(input(), conversation());
      const second = await manager.create({ ...input(), accountId: 'other' }, conversation());

      await expect(manager.linkPlan(first.id, 'plan', second.id, 'Builder')).rejects.toThrow(
        'Linked chats must use the same account.',
      );
    });

    it('rejects linking a plan that does not exist', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const first = await manager.create(input(), conversation());
      const second = await manager.create(input(), conversation());

      await expect(manager.linkPlan(first.id, 'missing', second.id, 'Builder')).rejects.toThrow(
        'The plan is unavailable.',
      );
    });

    it('updates the role of an already linked chat without demoting the author', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
      );
      await manager.initialize();
      const author = await manager.create(input(), conversation());
      const builder = await manager.create(input(), conversation());
      const reviewer = await manager.create(input(), conversation());
      const owner = { id: author.id, accountProvider: 'fixture', accountId: 'account' };
      const plan = (
        await manager.updatePlan(owner, {
          id: null,
          expectedRevision: null,
          title: 'Plan',
          summary: 'Summary',
          markdown: '# Plan',
          todos: [],
        })
      ).plans![0]!;
      await manager.linkPlan(author.id, plan.id, builder.id, 'Builder');
      await manager.linkPlan(author.id, plan.id, reviewer.id, 'Reviewer');

      const relinked = await manager.linkPlan(author.id, plan.id, builder.id, 'Reviewer');
      const unchanged = await manager.linkPlan(author.id, plan.id, author.id, 'Builder');

      expect(relinked.plans!.at(-1)!.agents).toEqual([
        { chatId: author.id, role: 'Author' },
        { chatId: builder.id, role: 'Reviewer' },
        { chatId: reviewer.id, role: 'Reviewer' },
      ]);
      expect(unchanged.plans!.at(-1)!.agents).toEqual(relinked.plans!.at(-1)!.agents);
    });
  });

  describe(ChatSessionManager.prototype.create, () => {
    it('falls back to a placeholder title when the generated title is blank', async () => {
      const manager = new ChatSessionManager(
        new MemoryChatSessionStore(),
        await ProjectContextResolver.folder(await projectFixture()),
        () => 'chat-blank-title',
        () => new Date(0),
        { generate: async () => '   ' },
      );
      await manager.initialize();
      const session = await manager.create(input(), conversation());

      await session.send('Hello', { push: () => {} }, new AbortController().signal);

      expect(session.summary).toMatchObject({ title: 'New chat', titleOrigin: 'generated' });
    });
  });
});

class MemoryChatSessionStore implements ChatSessionStore {
  records: readonly ChatSessionRecord[] = [];
  failure: Error | undefined;
  failOnSaveCall: number | undefined;
  saveCalls = 0;

  async initialize(_context: ProjectContext): Promise<void> {}

  async load(projectContextId: string): Promise<readonly ChatSessionRecord[]> {
    return structuredClone(this.records.filter(record => record.projectContextId === projectContextId));
  }

  async save(record: ChatSessionRecord): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls === this.failOnSaveCall) {
      this.failure = new Error('checkpoint unavailable');
    }
    if (this.failure) throw this.failure;
    this.records = [...this.records.filter(candidate => candidate.id !== record.id), structuredClone(record)];
  }

  async dispose(): Promise<void> {}
}

class StatefulProvider implements ChatProvider {
  readonly model = 'model';
  private messages: string[];

  constructor(state?: ChatProviderState) {
    this.messages = state ? [...(state.data as { messages: string[] }).messages] : [];
  }

  recordContext(events: readonly import('#src/chat/ChatContextEvent.js').ChatContextEvent[]): void {
    this.messages.push(...events.map(event => `context:${event.id}`));
  }

  exportState(): ChatProviderState {
    return { provider: 'test', version: 1, data: { messages: [...this.messages] } };
  }

  restoreState(state: ChatProviderState): void {
    this.messages = [...(state.data as { messages: string[] }).messages];
  }

  reset(): void {
    this.messages = [];
  }

  async send(requestInput: ChatRequestInput, options: Parameters<ChatProvider['send']>[1]): Promise<TurnResult> {
    const text = typeof requestInput === 'string' ? requestInput : requestInput.text;
    this.messages.push(text);
    if (text === 'tool then fail') {
      this.messages.push('tool-result:mutation-complete');
      await options.onStateCheckpoint?.(this.exportState());
      throw new Error('provider failed after tool execution');
    }
    if (text === 'tool outcome checkpoint fails') {
      this.messages.push('tool-intent:mutation');
      await options.onStateCheckpoint?.(this.exportState());
      this.messages.push('tool-result:mutation-complete');
      await options.onStateCheckpoint?.(this.exportState());
    }
    options.onReasoningSummary?.('thinking');
    options.onText('answer');
    return { responseId: 'response', usage: null };
  }
}

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-chat-project-'));
  temporaryPaths.push(root);
  return root;
}

function input() {
  return {
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'model',
    modelName: 'Model',
  };
}

function conversation(state?: ChatProviderState): ChatConversation {
  return new ChatConversation(
    new StatefulProvider(state),
    new NullLogger(),
    value => value,
    () => {},
    false,
  );
}

function providerMessages(record: ChatSessionRecord): readonly string[] {
  return (record.providerState.data as { messages: string[] }).messages;
}

function sequentialIds(prefix = 'chat-'): () => string {
  let value = 0;
  return () => `${prefix}${++value}`;
}

function fixedClock(): () => Date {
  let milliseconds = 0;
  return () => new Date(milliseconds++);
}

describe('plan builds', () => {
  it('pauses the current build and resumes its namespaced todos after another plan uses the builder', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const author = await manager.create(input(), conversation());
    const builder = await manager.create(input(), conversation());
    const owner = { id: author.id, accountProvider: 'fixture', accountId: 'account' };
    const first = (
      await manager.updatePlan(owner, {
        id: null,
        expectedRevision: null,
        title: 'First plan',
        summary: 'Summary',
        markdown: '# First',
        todos: [
          { id: 'done', text: 'Finish this before pausing', completed: false },
          { id: 'step', text: 'Shared ID in the first plan', completed: false },
        ],
      })
    ).plans!.at(-1)!;
    const second = (
      await manager.updatePlan(owner, {
        id: null,
        expectedRevision: null,
        title: 'Second plan',
        summary: 'Summary',
        markdown: '# Second',
        todos: [{ id: 'step', text: 'Shared ID in the second plan', completed: false }],
      })
    ).plans!.at(-1)!;

    await manager.startPlanBuild(author.id, first.id, builder.id, 'first-run');
    await manager.updateTodos(
      { id: builder.id, accountProvider: 'fixture', accountId: 'account' },
      {
        items: [{ id: 'done', text: 'Finish this before pausing', status: TodoStatus.COMPLETED }],
        replace: false,
      },
    );
    await manager.syncPlanBuild(builder.id);
    const switched = await manager.startPlanBuild(author.id, second.id, builder.id, 'second-run');
    const pausedFirst = switched.find(chat => chat.id === author.id)!.plans!.findLast(plan => plan.id === first.id)!;
    const activeSecond = switched.find(chat => chat.id === author.id)!.plans!.findLast(plan => plan.id === second.id)!;
    const secondTray = switched.find(chat => chat.id === builder.id)!.todos!;

    expect(pausedFirst).toMatchObject({
      todos: [
        { id: 'done', completed: true },
        { id: 'step', completed: false },
      ],
    });
    expect(pausedFirst.build).toBeUndefined();
    expect(activeSecond.build).toMatchObject({ chatId: builder.id, runId: 'second-run' });
    expect(secondTray).toEqual([
      { id: `plan:${second.id}:step`, text: 'Shared ID in the second plan', status: TodoStatus.PENDING },
    ]);

    await manager.updateTodos(
      { id: builder.id, accountProvider: 'fixture', accountId: 'account' },
      {
        items: [{ id: 'step', text: 'Shared ID in the second plan', status: TodoStatus.COMPLETED }],
        replace: false,
      },
    );
    await manager.syncPlanBuild(builder.id);
    const resumed = await manager.startPlanBuild(author.id, first.id, builder.id, 'resumed-run');
    const pausedSecond = resumed.find(chat => chat.id === author.id)!.plans!.findLast(plan => plan.id === second.id)!;
    const resumedFirst = resumed.find(chat => chat.id === author.id)!.plans!.findLast(plan => plan.id === first.id)!;
    const resumedTray = resumed.find(chat => chat.id === builder.id)!.todos!;

    expect(pausedSecond.build).toBeUndefined();
    expect(pausedSecond.todos).toEqual([{ id: 'step', text: 'Shared ID in the second plan', completed: true }]);
    expect(resumedFirst.build).toMatchObject({ chatId: builder.id, runId: 'resumed-run' });
    expect(resumedFirst.todos).toMatchObject([
      { id: 'done', completed: true },
      { id: 'step', completed: false },
    ]);
    expect(resumedTray).toEqual([
      { id: `plan:${first.id}:done`, text: 'Finish this before pausing', status: TodoStatus.COMPLETED },
      { id: `plan:${first.id}:step`, text: 'Shared ID in the first plan', status: TodoStatus.PENDING },
    ]);
  });

  it('marks plan todos off as the builder completes them without saving a new plan revision', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const author = await manager.create(input(), conversation());
    const builder = await manager.create(input(), conversation());
    const plan = (
      await manager.updatePlan(
        { id: author.id, accountProvider: 'fixture', accountId: 'account' },
        {
          id: null,
          expectedRevision: null,
          title: 'Plan',
          summary: 'Summary',
          markdown: '# Plan',
          todos: [
            { id: 'first', text: 'First', completed: false },
            { id: 'second', text: 'Second', completed: false },
          ],
        },
      )
    ).plans!.at(-1)!;

    const started = await manager.startPlanBuild(author.id, plan.id, builder.id, 'run');
    await manager.updateTodos(
      { id: builder.id, accountProvider: 'fixture', accountId: 'account' },
      { items: [], replace: true },
    );
    const unchanged = await manager.syncPlanBuild(builder.id);
    await manager.updateTodos(
      { id: builder.id, accountProvider: 'fixture', accountId: 'account' },
      { items: [{ id: 'first', text: 'First', status: TodoStatus.COMPLETED }], replace: false },
    );
    const [synced] = await manager.syncPlanBuild(builder.id);

    expect(started.find(chat => chat.id === builder.id)?.todos).toEqual([
      { id: `plan:${plan.id}:first`, text: 'First', status: TodoStatus.PENDING },
      { id: `plan:${plan.id}:second`, text: 'Second', status: TodoStatus.PENDING },
    ]);
    expect(unchanged).toEqual([]);
    expect(synced!.plans).toHaveLength(1);
    expect(synced!.plans!.at(-1)).toMatchObject({
      revision: 1,
      todos: [
        { id: 'first', completed: true },
        { id: 'second', completed: false },
      ],
      build: { chatId: builder.id, runId: 'run' },
    });
  });

  it('keeps building after a turn ends with todos left and finishes once every todo is done', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const chat = await manager.create(input(), conversation());
    const owner = { id: chat.id, accountProvider: 'fixture', accountId: 'account' };
    const plan = (
      await manager.updatePlan(owner, {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [{ id: 'only', text: 'Only step', completed: false }],
      })
    ).plans!.at(-1)!;
    await manager.startPlanBuild(chat.id, plan.id, chat.id, 'run');

    expect(await manager.finishPlanBuildRun(chat.id, 'run')).toEqual([]);
    await manager.updateTodos(owner, {
      items: [{ id: 'only', text: 'Only step', status: TodoStatus.COMPLETED }],
      replace: false,
    });
    const [finished] = await manager.syncPlanBuild(chat.id);

    expect(finished!.plans!.at(-1)!.build).toBeUndefined();
    expect(finished!.plans!.at(-1)!.todos).toEqual([{ id: 'only', text: 'Only step', completed: true }]);
  });

  it('finishes a build without todos when its turn ends', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const chat = await manager.create(input(), conversation());
    const plan = (
      await manager.updatePlan(
        { id: chat.id, accountProvider: 'fixture', accountId: 'account' },
        { id: null, expectedRevision: null, title: 'Plan', summary: 'Summary', markdown: '# Plan', todos: [] },
      )
    ).plans!.at(-1)!;
    await manager.startPlanBuild(chat.id, plan.id, chat.id, 'run');

    expect(await manager.finishPlanBuildRun(chat.id, 'another run')).toEqual([]);
    const [finished] = await manager.finishPlanBuildRun(chat.id, 'run');

    expect(finished!.plans!.at(-1)!.build).toBeUndefined();
  });

  it('carries a todo ticked on the plan over to the builder’s list', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const author = await manager.create(input(), conversation());
    const builder = await manager.create(input(), conversation());
    const plan = (
      await manager.updatePlan(
        { id: author.id, accountProvider: 'fixture', accountId: 'account' },
        {
          id: null,
          expectedRevision: null,
          title: 'Plan',
          summary: 'Summary',
          markdown: '# Plan',
          todos: [
            { id: 'first', text: 'First', completed: false },
            { id: 'second', text: 'Second', completed: false },
          ],
        },
      )
    ).plans!.at(-1)!;
    await manager.startPlanBuild(author.id, plan.id, builder.id, 'run');

    const [, initiallyPending] = await manager.setPlanTodo(author.id, plan.id, 'first', false);
    const [source, tray] = await manager.setPlanTodo(author.id, plan.id, 'first', true);
    const [, reopened] = await manager.setPlanTodo(author.id, plan.id, 'first', false);

    expect(source!.plans!.at(-1)).toMatchObject({ revision: 1, todos: [{ id: 'first', completed: true }, {}] });
    expect(initiallyPending!.todos![0]!.status).toBe(TodoStatus.PENDING);
    expect(tray!.todos![0]).toEqual({
      id: `plan:${plan.id}:first`,
      text: 'First',
      status: TodoStatus.COMPLETED,
    });
    expect(reopened!.todos![0]!.status).toBe(TodoStatus.PENDING);
    await expect(manager.setPlanTodo(author.id, plan.id, 'missing', true)).rejects.toThrow(
      'The plan todo is unavailable.',
    );
  });

  it('stops a build on request while keeping the plan’s todo progress, including across a new revision', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const chat = await manager.create(input(), conversation());
    const owner = { id: chat.id, accountProvider: 'fixture', accountId: 'account' };
    const plan = (
      await manager.updatePlan(owner, {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [
          { id: 'first', text: 'First', completed: false },
          { id: 'second', text: 'Second', completed: false },
        ],
      })
    ).plans!.at(-1)!;
    await manager.startPlanBuild(chat.id, plan.id, chat.id, 'run');
    await manager.setPlanTodo(chat.id, plan.id, 'first', true);

    const revised = await manager.updatePlan(owner, {
      id: plan.id,
      expectedRevision: 1,
      title: 'Plan',
      summary: 'Revised',
      markdown: '# Plan',
      todos: [
        { id: 'first', text: 'First', completed: true },
        { id: 'second', text: 'Second', completed: false },
      ],
    });
    const stopped = await manager.stopPlanBuild(chat.id, plan.id);

    expect(revised.plans!.at(-1)).toMatchObject({ revision: 2, build: { chatId: chat.id, runId: 'run' } });
    expect(stopped.plans!.at(-1)!.build).toBeUndefined();
    expect(stopped.plans!.at(-1)!.todos.map(todo => todo.completed)).toEqual([true, false]);
  });

  it('refuses to build a plan into a chat from another account', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const author = await manager.create(input(), conversation());
    const other = await manager.create({ ...input(), accountId: 'other' }, conversation());
    const plan = (
      await manager.updatePlan(
        { id: author.id, accountProvider: 'fixture', accountId: 'account' },
        { id: null, expectedRevision: null, title: 'Plan', summary: 'Summary', markdown: '# Plan', todos: [] },
      )
    ).plans!.at(-1)!;

    await expect(manager.startPlanBuild(author.id, plan.id, other.id, 'run')).rejects.toThrow(
      'Linked chats must use the same account.',
    );
    await expect(manager.startPlanBuild(author.id, 'missing', author.id, 'run')).rejects.toThrow(
      'The plan is unavailable.',
    );
  });

  it('handles plan progress requests when no build or plan exists', async () => {
    const manager = new ChatSessionManager(
      new MemoryChatSessionStore(),
      await ProjectContextResolver.folder(await projectFixture()),
    );
    await manager.initialize();
    const chat = await manager.create(input(), conversation());
    const owner = { id: chat.id, accountProvider: 'fixture', accountId: 'account' };
    const plan = (
      await manager.updatePlan(owner, {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [{ id: 'todo', text: 'Todo', completed: false }],
      })
    ).plans!.at(-1)!;

    expect(await manager.syncPlanBuild(chat.id)).toEqual([]);
    const [updated] = await manager.setPlanTodo(chat.id, plan.id, 'todo', true);
    expect(updated!.plans!.at(-1)!.todos[0]!.completed).toBe(true);
    await expect(manager.setPlanTodo(chat.id, 'missing', 'todo', true)).rejects.toThrow('The plan is unavailable.');
    await expect(manager.stopPlanBuild(chat.id, 'missing')).rejects.toThrow('The plan is unavailable.');
  });
});
