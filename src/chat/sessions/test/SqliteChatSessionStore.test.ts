import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistenceError } from '../../../errors/PersistenceError.ts';
import { ProjectContextResolver } from '../../../project/context/ProjectContextResolver.ts';
import type { ChatSessionRecord } from '../ChatSessionRecord.ts';
import { SqliteChatSessionStore } from '../SqliteChatSessionStore.ts';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(SqliteChatSessionStore, () => {
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
