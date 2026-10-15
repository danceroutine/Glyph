import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteChatSessionStore } from '#src/chat/sessions/SqliteChatSessionStore.js';
import { ProjectContextResolver } from '#src/project/context/ProjectContextResolver.js';

const { readLegacy } = vi.hoisted(() => ({ readLegacy: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: readLegacy,
}));

const directories: string[] = [];
const stores: SqliteChatSessionStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  readLegacy.mockReset();
});

describe('concurrent saved-chat initialization', () => {
  it('rejects failure-handler startup retries after disposal begins without reopening the database', async () => {
    const directory = await fixture();
    const context = await ProjectContextResolver.folder(await fixture(), 'local');
    const firstRead = deferred<string>();
    readLegacy.mockReturnValueOnce(firstRead.promise).mockResolvedValue(legacyCatalog(context.roots[0]!.path));
    const store = new SqliteChatSessionStore(directory);
    stores.push(store);
    const startup = store.initialize(context);
    const retried = startup.catch(() => store.initialize(context));
    const result = retried.then(
      () => undefined,
      error => error,
    );
    await vi.waitFor(() => expect(readLegacy).toHaveBeenCalledTimes(1));
    const disposal = store.dispose();
    firstRead.reject(new Error('First migration read failed.'));
    await disposal;

    expect(await result).toBeInstanceOf(Error);
    expect(readLegacy).toHaveBeenCalledTimes(1);
    await expect(store.initialize(context)).rejects.toThrow('Could not initialize saved chats.');
    await expect(store.load(context.id)).rejects.toThrow('Could not load saved chats.');
  });

  it('rechecks the migration marker after a peer migrates and checkpoints a newer chat', async () => {
    const directory = await fixture();
    const context = await ProjectContextResolver.folder(await fixture(), 'local');
    const firstRead = deferred<string>();
    const secondRead = deferred<string>();
    readLegacy.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(secondRead.promise);
    const first = new SqliteChatSessionStore(directory);
    const second = new SqliteChatSessionStore(directory);
    stores.push(first, second);
    const firstInit = first.initialize(context);
    await vi.waitFor(() => expect(readLegacy).toHaveBeenCalledTimes(1));
    const secondInit = second.initialize(context);
    const secondResult = secondInit.then(
      () => undefined,
      error => error,
    );
    await vi.waitFor(() => expect(readLegacy).toHaveBeenCalledTimes(2));
    const catalog = legacyCatalog(context.roots[0]!.path);
    firstRead.resolve(catalog);
    await firstInit;
    const [imported] = await first.load(context.id);
    const checkpoint = { ...imported!, title: 'Renamed after migration' };
    await first.save(checkpoint);
    secondRead.resolve(catalog);

    expect(await secondResult).toBeUndefined();
    expect(await second.load(context.id)).toEqual([checkpoint]);
  });

  it('does not expose a same-store connection before migration and context registration finish', async () => {
    const directory = await fixture();
    const firstContext = await ProjectContextResolver.folder(await fixture(), 'local');
    const secondContext = await ProjectContextResolver.folder(await fixture(), 'local');
    const read = deferred<string>();
    readLegacy.mockReturnValue(read.promise);
    const store = new SqliteChatSessionStore(directory);
    stores.push(store);
    const first = store.initialize(firstContext);
    await vi.waitFor(() => expect(readLegacy).toHaveBeenCalledTimes(1));
    let secondSettled = false;
    const second = store.initialize(secondContext).then(() => {
      secondSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    const settledBeforeMigration = secondSettled;
    read.resolve(legacyCatalog(firstContext.roots[0]!.path));
    await Promise.all([first, second]);

    expect(settledBeforeMigration).toBe(false);
    expect(readLegacy).toHaveBeenCalledTimes(1);
    expect(await store.load(firstContext.id)).toHaveLength(1);
    expect(await store.load(secondContext.id)).toEqual([]);
  });

  it('waits for pending initialization before closing its database handle', async () => {
    const directory = await fixture();
    const context = await ProjectContextResolver.folder(await fixture(), 'local');
    const read = deferred<string>();
    readLegacy.mockReturnValue(read.promise);
    const store = new SqliteChatSessionStore(directory);
    stores.push(store);
    const startup = store.initialize(context);
    await vi.waitFor(() => expect(readLegacy).toHaveBeenCalledTimes(1));
    let disposed = false;
    const disposal = store.dispose().then(() => {
      disposed = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    const disposedBeforeStartupSettled = disposed;
    read.resolve(legacyCatalog(context.roots[0]!.path));
    await Promise.allSettled([startup, disposal]);

    expect(disposedBeforeStartupSettled).toBe(false);
    await expect(store.load(context.id)).rejects.toThrow('Could not load saved chats.');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-chat-startup-'));
  directories.push(directory);
  return directory;
}

function legacyCatalog(root: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    chats: [
      {
        schemaVersion: 1,
        id: 'legacy-chat',
        title: 'Original title',
        titleOrigin: 'human',
        scope: { kind: 'workspace', root },
        accountClientId: 'client',
        accountSubject: 'subject',
        modelSlug: 'model',
        modelName: 'Model',
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
        providerState: { provider: 'test', version: 1, data: { history: [] } },
        transcript: [],
      },
    ],
  });
}
