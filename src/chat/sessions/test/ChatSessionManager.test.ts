import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '../../../observability/NullLogger.ts';
import type { ProjectContext } from '../../../project/context/ProjectContext.ts';
import { ProjectContextResolver } from '../../../project/context/ProjectContextResolver.ts';
import { ChatConversation } from '../../ChatConversation.ts';
import type { ChatProvider } from '../../ChatProvider.ts';
import type { ChatProviderState } from '../../ChatProviderState.ts';
import type { ChatRequestInput } from '../../ChatRequest.ts';
import { ChatResponsePartType } from '../../ChatResponsePartType.ts';
import type { TurnResult } from '../../TurnResult.ts';
import { ChatSessionManager } from '../ChatSessionManager.ts';
import type { ChatSessionRecord } from '../ChatSessionRecord.ts';
import type { ChatSessionStore } from '../ChatSessionStore.ts';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ChatSessionManager, () => {
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
});

class MemoryChatSessionStore implements ChatSessionStore {
  records: readonly ChatSessionRecord[] = [];
  failure: Error | undefined;

  async initialize(_context: ProjectContext): Promise<void> {}

  async load(projectContextId: string): Promise<readonly ChatSessionRecord[]> {
    return structuredClone(this.records.filter(record => record.projectContextId === projectContextId));
  }

  async save(record: ChatSessionRecord): Promise<void> {
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

  recordContext(events: readonly import('../../ChatContextEvent.ts').ChatContextEvent[]): void {
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

  async send(input: ChatRequestInput, options: Parameters<ChatProvider['send']>[1]): Promise<TurnResult> {
    const text = typeof input === 'string' ? input : input.text;
    this.messages.push(text);
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
