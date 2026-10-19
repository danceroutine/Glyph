import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { toChatUsage } from '#src/chat/sessions/ChatUsage.js';
import { PersistenceError } from '#src/errors/PersistenceError.js';
import { ProjectContextResolver } from '#src/project/context/ProjectContextResolver.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import { SqliteChatSessionStore } from '#src/chat/sessions/SqliteChatSessionStore.js';
import { TodoStatus } from '#src/todos/TodoStatus.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(SqliteChatSessionStore, () => {
  it('preserves all IDE capture kinds and exact provenance across database reopen', async () => {
    const directory = await fixture('glyph-ide-captures-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-ide-project-'), 'local');
    const attachments = (['diagnostic', 'symbol', 'diff', 'terminal', 'test'] as const).map(kind => ({
      path: `${kind} capture`,
      text: `immutable ${kind}`,
      revision: `hash-${kind}`,
      byteOrderMark: false,
      byteLength: 20,
      source: { kind, uri: `glyph-${kind}:/original`, version: 3, revision: 'original-editor-revision' },
    }));
    const original = record(context.id);
    const saved = { ...original, transcript: original.transcript.map(turn => ({ ...turn, attachments })) };
    const store = new SqliteChatSessionStore(directory);
    await store.initialize(context);
    await store.save(saved);
    await store.dispose();
    const reopened = new SqliteChatSessionStore(directory);
    await reopened.initialize(context);
    expect((await reopened.load(context.id))[0]).toEqual(saved);
    await reopened.dispose();
  });

  it('migrates steering history and preserves instructions and captured context after reopening', async () => {
    const directory = await fixture('glyph-steering-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-steering-project-'), 'local');
    const store = new SqliteChatSessionStore(directory);
    await store.initialize(context);
    await store.save(record(context.id));
    await store.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec('ALTER TABLE chat_turns DROP COLUMN steering');
    database.close();
    const migrated = new SqliteChatSessionStore(directory);
    await migrated.initialize(context);
    const source = record(context.id);
    const saved = {
      ...source,
      transcript: source.transcript.map(turn => ({
        ...turn,
        steering: [
          {
            id: 'guidance',
            text: 'Keep working',
            createdAt: source.createdAt,
            options: { mode: AgentModeID.PLAN },
            attachments: [{ path: 'README.md', text: 'Exact capture', revision: 'r1' }],
          },
        ],
      })),
    };
    await migrated.save(saved);
    await migrated.dispose();
    const reopened = new SqliteChatSessionStore(directory);
    await reopened.initialize(context);
    expect((await reopened.load(context.id))[0]).toEqual(saved);
    await reopened.dispose();
  });

  it.each([undefined, new Date(0).toISOString()])(
    'migrates mode switch announcements and preserves their countdown origin (%s) on reopen',
    async startedAt => {
      const directory = await fixture('glyph-mode-switch-');
      const context = await ProjectContextResolver.folder(await fixture('glyph-mode-project-'), 'local');
      const seed = new SqliteChatSessionStore(directory);
      await seed.initialize(context);
      await seed.save(record(context.id));
      await seed.dispose();
      const database = new Database(join(directory, 'chats.sqlite3'));
      database.exec('ALTER TABLE chat_turns DROP COLUMN mode_swaps');
      database.close();
      const source = record(context.id);
      const saved = {
        ...source,
        mode: AgentModeID.AGENT as const,
        transcript: source.transcript.map(turn => ({
          ...turn,
          modeSwaps: [
            {
              id: 'swap',
              source: AgentModeID.PLAN as const,
              target: AgentModeID.AGENT as const,
              description: 'Implement the approved plan.',
              status: GlyphModeSwapStatus.APPROVED as const,
              ...(startedAt ? { startedAt } : {}),
              expiresAt: new Date(0).toISOString(),
              autoApprove: false,
            },
          ],
        })),
      };
      const migrated = new SqliteChatSessionStore(directory);
      await migrated.initialize(context);
      expect((await migrated.load(context.id))[0]!.transcript[0]!.modeSwaps).toBeUndefined();
      await migrated.save(saved);
      await migrated.dispose();
      const reopened = new SqliteChatSessionStore(directory);
      await reopened.initialize(context);
      expect((await reopened.load(context.id))[0]).toEqual(saved);
      await reopened.dispose();
    },
  );

  it('migrates turn checkpoints and preserves their provider history across reopening', async () => {
    const directory = await fixture('glyph-checkpoints-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-checkpoint-project-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    await seed.initialize(context);
    await seed.save(record(context.id));
    await seed.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec('ALTER TABLE chat_turns DROP COLUMN checkpoints');
    database.close();
    const source = record(context.id);
    const checkpoint = { providerState: source.providerState, mode: AgentModeID.AGENT as const, plans: [], todos: [] };
    const saved = {
      ...source,
      transcript: source.transcript.map(turn => ({
        ...turn,
        checkpoints: {
          before: checkpoint,
          after: { ...checkpoint, providerState: { ...source.providerState, data: { messages: ['first'] } } },
        },
      })),
    };
    const migrated = new SqliteChatSessionStore(directory);
    await migrated.initialize(context);
    expect((await migrated.load(context.id))[0]!.transcript[0]!.checkpoints).toBeUndefined();
    await migrated.save(saved);
    await migrated.dispose();
    const reopened = new SqliteChatSessionStore(directory);
    await reopened.initialize(context);
    expect((await reopened.load(context.id))[0]).toEqual(saved);
    await reopened.dispose();
  });

  it('migrates and reopens plan revisions and exact annotations without rereading the source', async () => {
    const directory = await fixture('glyph-plans-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-plan-project-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    await seed.initialize(context);
    await seed.save(record(context.id));
    await seed.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec(
      'ALTER TABLE chats DROP COLUMN plans; ALTER TABLE chats DROP COLUMN mode; ALTER TABLE chat_turns DROP COLUMN options',
    );
    database.close();
    const annotation = {
      id: 'a',
      order: 1,
      kind: 'chat' as const,
      sourceId: 'turn:1',
      revision: '1',
      label: 'Glyph',
      quote: 'café 🌱',
      from: 2,
      to: 9,
      comment: 'Keep this exact quote',
    };
    const plan = {
      id: 'plan',
      revision: 1,
      title: 'Plan',
      summary: 'Summary',
      markdown: '# Plan',
      todos: [],
      agents: [{ chatId: record(context.id).id, role: 'Author' as const }],
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new SqliteChatSessionStore(directory);
      await store.initialize(context);
      const loaded = (await store.load(context.id))[0]!;
      if (attempt === 0)
        await store.save({
          ...loaded,
          plans: [plan],
          mode: AgentModeID.PLAN,
          transcript: [
            {
              ...loaded.transcript[0]!,
              options: { mode: AgentModeID.PLAN, annotations: [annotation], attachmentSpans: [{ from: 4, to: 9 }] },
            },
          ],
        });
      else {
        expect(loaded.plans).toEqual([plan]);
        expect(loaded.mode).toBe('plan');
        expect(loaded.transcript[0]!.options).toEqual({
          mode: AgentModeID.PLAN,
          annotations: [annotation],
          attachmentSpans: [{ from: 4, to: 9 }],
        });
      }
      await store.dispose();
    }
  });

  it('upgrades catalogs without todos and preserves chat-scoped lists across repeated reopen', async () => {
    const directory = await fixture('glyph-chat-todos-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-chat-project-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    await seed.initialize(context);
    await seed.save(record(context.id));
    await seed.save({ ...record(context.id), id: 'other' });
    await seed.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec('ALTER TABLE chats DROP COLUMN todos');
    database.close();
    const todos = [{ id: 'a', text: 'Resume this work', status: TodoStatus.IN_PROGRESS }];
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new SqliteChatSessionStore(directory);
      try {
        await store.initialize(context);
        const records = await store.load(context.id);
        const first = records.find(value => value.id === record(context.id).id)!;
        expect(records.find(value => value.id === 'other')?.todos).toBeUndefined();
        if (attempt === 0) {
          expect(first.todos).toBeUndefined();
          await store.save({ ...first, todos });
        } else {
          expect(first.todos).toEqual(todos);
          expect(first.transcript).toEqual(record(context.id).transcript);
        }
      } finally {
        await store.dispose();
      }
    }
  });

  it('migrates legacy turns and persists exact captured text and provenance after reopen', async () => {
    const directory = await fixture('glyph-chat-attachments-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-chat-project-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    await seed.initialize(context);
    await seed.save(record(context.id));
    await seed.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec('ALTER TABLE chat_turns DROP COLUMN attachments');
    database.close();
    const attachments = [
      {
        path: 'a.ts',
        text: '  café 🌱\r\n\tselected',
        revision: 'exact-hash',
        byteOrderMark: false,
        byteLength: Buffer.byteLength('  café 🌱\r\n\tselected'),
        source: {
          kind: 'selection' as const,
          uri: 'file:///project/a.ts',
          version: 7,
          revision: 'generation:incarnation:7',
          range: { start: { line: 2, column: 1 }, end: { line: 3, column: 10 } },
          side: 'original' as const,
        },
      },
      {
        path: 'src',
        text: 'index.ts',
        revision: 'tree-hash',
        byteOrderMark: false,
        byteLength: 8,
        source: { kind: 'folder' as const, uri: 'file:///project/src', version: 0, revision: 'tree-hash' },
      },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new SqliteChatSessionStore(directory);
      try {
        await store.initialize(context);
        const loaded = (await store.load(context.id))[0]!;
        if (attempt === 0) {
          expect(loaded.transcript[0]?.attachments).toBeUndefined();
          await store.save({ ...loaded, transcript: [{ ...loaded.transcript[0]!, attachments }] });
        } else expect(loaded.transcript[0]?.attachments).toEqual(attachments);
      } finally {
        await store.dispose();
      }
    }
  });

  it('upgrades an existing turn table without inventing usage and preserves new reports across repeated reopen', async () => {
    const directory = await fixture('glyph-chat-usage-migration-');
    const context = await ProjectContextResolver.folder(await fixture('glyph-chat-project-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    await seed.initialize(context);
    await seed.save(record(context.id));
    await seed.dispose();
    const database = new Database(join(directory, 'chats.sqlite3'));
    database.exec('ALTER TABLE chat_turns DROP COLUMN usage');
    database.exec('ALTER TABLE chat_turns DROP COLUMN tools');
    database.close();
    const usage = { inputTokens: 100, cachedInputTokens: 30, outputTokens: 40, reasoningTokens: 10, totalTokens: 140 };
    const tool = {
      callId: 'call',
      name: 'execute_shell',
      phase: ToolActivityPhase.COMPLETED,
      shell: {
        command: 'pwd',
        output: '/project\n',
        workingDirectory: '/project',
        sessionId: 'session',
        exitCode: 0,
        background: false,
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new SqliteChatSessionStore(directory);
      try {
        await store.initialize(context);
        const loaded = (await store.load(context.id))[0]!;
        expect(loaded.transcript[0]).toEqual(record(context.id).transcript[0]);
        if (attempt === 0) {
          expect(toChatUsage(loaded.transcript)).toMatchObject({ totalTokens: 0, unreportedTurns: 1 });
          await store.save({
            ...loaded,
            transcript: [
              ...loaded.transcript,
              { ...loaded.transcript[0]!, usage: { ...usage, incomplete: true }, tools: [tool] },
            ],
          });
        } else {
          expect(loaded.transcript[1]).toMatchObject({ usage: { ...usage, incomplete: true }, tools: [tool] });
          expect(toChatUsage(loaded.transcript)).toEqual({ ...usage, unreportedTurns: 2 });
        }
      } finally {
        await store.dispose();
      }
    }
  });

  it('merges legacy context chats without changing their transcripts or provider state and can repeat the migration', async () => {
    const directory = await fixture('glyph-chat-context-migration-');
    const first = await ProjectContextResolver.folder(await fixture('glyph-old-context-'), 'local');
    const target = await ProjectContextResolver.folder(await fixture('glyph-new-context-'), 'local');
    const seed = new SqliteChatSessionStore(directory);
    const existing = { ...record(target.id), id: 'already-current' };
    try {
      await seed.initialize(first);
      await seed.initialize(target);
      await seed.save(record(first.id));
      await seed.save(existing);
    } finally {
      await seed.dispose();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new SqliteChatSessionStore(directory, {
        contextMigration: { targetId: target.id, sourceIds: [first.id] },
      });
      try {
        await store.initialize(target);
        expect(await store.load(target.id)).toEqual(expect.arrayContaining([record(target.id), existing]));
        expect(await store.load(target.id)).toHaveLength(2);
        expect(await store.load(first.id)).toEqual([]);
      } finally {
        await store.dispose();
      }
    }
  });

  it('persists individual chats, indexes them by project context, and uses owner-only permissions', async () => {
    const directory = await fixture('glyph-chat-store-');
    const firstRoot = await fixture('glyph-chat-project-');
    const secondRoot = await fixture('glyph-chat-project-');
    const first = await ProjectContextResolver.folder(firstRoot, 'local');
    const second = await ProjectContextResolver.folder(secondRoot, 'local');
    const store = new SqliteChatSessionStore(directory);
    await store.initialize(first);
    await store.initialize(second);

    await store.save(record(first.id));

    await expect(store.load(first.id)).resolves.toEqual([record(first.id)]);
    await expect(store.load(second.id)).resolves.toEqual([]);
    expect((await stat(join(directory, 'chats.sqlite3'))).mode & 0o777).toBe(0o600);
    await store.dispose();
  });

  it('migrates the legacy global JSON catalog once without deleting the recovery source', async () => {
    const directory = await fixture('glyph-chat-store-');
    const project = await fixture('glyph-chat-project-');
    const context = await ProjectContextResolver.folder(project, 'local');
    await writeFile(
      join(directory, 'chats.json'),
      JSON.stringify({
        schemaVersion: 1,
        chats: [
          {
            ...record(context.id),
            schemaVersion: 1,
            scope: { kind: 'workspace', root: context.roots[0]!.path },
            projectContextId: undefined,
            accountProvider: undefined,
            accountId: undefined,
            accountClientId: 'client',
            accountSubject: 'subject',
          },
        ],
      }),
    );
    const store = new SqliteChatSessionStore(directory);

    await store.initialize(context);

    await expect(store.load(context.id)).resolves.toEqual([
      {
        ...record(context.id),
        accountProvider: 'openai',
        accountId: JSON.stringify(['client', 'subject']),
      },
    ]);
    await expect(stat(join(directory, 'chats.json'))).resolves.toBeDefined();
    await store.dispose();
  });

  it('loads schema-v2 OpenAI ownership as a provider-neutral account identity', async () => {
    const directory = await fixture('glyph-chat-store-');
    const project = await fixture('glyph-chat-project-');
    const context = await ProjectContextResolver.folder(project, 'local');
    const store = new SqliteChatSessionStore(directory);
    await store.initialize(context);
    const database = new Database(join(directory, 'chats.sqlite3'));
    database
      .prepare(
        `INSERT INTO chats(
           id, schema_version, project_context_id, title, title_origin,
           account_client_id, account_subject, model_slug, model_name,
           created_at, updated_at, provider_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-chat',
        2,
        context.id,
        'Legacy Chat',
        'human',
        'client',
        'subject',
        'model',
        'Model',
        '2026-10-06T00:00:00.000Z',
        '2026-10-06T00:00:00.000Z',
        JSON.stringify({ provider: 'openai-responses', version: 1, data: { history: [] } }),
      );
    database.close();

    await expect(store.load(context.id)).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: 3,
        accountProvider: 'openai',
        accountId: JSON.stringify(['client', 'subject']),
      }),
    ]);
    await store.dispose();
  });

  it('rejects malformed legacy catalogs and invalid records', async () => {
    const directory = await fixture('glyph-chat-store-');
    const project = await fixture('glyph-chat-project-');
    const context = await ProjectContextResolver.folder(project, 'local');
    await writeFile(join(directory, 'chats.json'), '{"schemaVersion":99,"chats":[]}');
    const store = new SqliteChatSessionStore(directory);

    await expect(store.initialize(context)).rejects.toBeInstanceOf(PersistenceError);

    await rm(join(directory, 'chats.json'));
    await store.initialize(context);
    await expect(
      store.save({ ...record(context.id), providerState: { provider: 'test', version: 1, data: undefined } }),
    ).rejects.toBeInstanceOf(PersistenceError);
    await store.dispose();
  });
});

function record(projectContextId: string): ChatSessionRecord {
  return {
    schemaVersion: 3,
    id: 'chat-id',
    title: 'Test Chat',
    titleOrigin: 'human',
    projectContextId,
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'model',
    modelName: 'Model',
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
    providerState: { provider: 'test', version: 1, data: { history: [] } },
    transcript: [
      {
        userText: 'Question',
        attachmentPaths: ['src/App.tsx'],
        assistantText: 'Answer',
        reasoningSummary: 'Reasoning summary',
        createdAt: '2026-10-06T00:00:00.000Z',
      },
    ],
  };
}

async function fixture(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}
