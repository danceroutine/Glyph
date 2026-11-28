import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { inspectPrivateDatabase } from '#src/workspace/privateStorageMetadata.js';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { optionalStat, privateSkillDirectory } from './SkillPackageStorage.ts';

const entrySchema = z
  .object({
    id: z.uuid(),
    root: z.string(),
    location: z.string(),
    directory: z.string(),
    skillId: z.string(),
    treeVersion: z.literal(2).optional(),
    expected: z.string().nullable(),
    replacement: z.string().nullable(),
    expectedMetadata: z.hash('sha256').optional(),
    replacementMetadata: z.hash('sha256').optional(),
    source: z.string().nullable(),
    createdParents: z.array(z.strictObject({ relative: z.string(), identity: z.hash('sha256') })).optional(),
    published: z.boolean(),
    retired: z.boolean().default(false),
  })
  .strict();
export type SkillTransaction = z.infer<typeof entrySchema>;

/** Only host-owned user storage describes recoverable transactions. Workspace directory names cannot initiate recovery. */
export class SkillTransactionJournal {
  constructor(
    private readonly userDirectory: string,
    private readonly metadata: FilesystemMetadata,
  ) {}
  async entries(root: string, location: string): Promise<SkillTransaction[]> {
    if (!(await optionalStat(join(this.userDirectory, '.skill-staging', 'journal.sqlite')))) return [];
    return this.use(db =>
      db
        .prepare<[string, string], { entry: string }>('SELECT entry FROM transactions WHERE root = ? AND location = ?')
        .all(root, location)
        .map(row => entrySchema.parse(JSON.parse(row.entry))),
    );
  }
  async hasOtherProjectTransaction(location: string, destination: string): Promise<boolean> {
    if (!(await optionalStat(join(this.userDirectory, '.skill-staging', 'journal.sqlite')))) return false;
    return this.use(db =>
      db
        .prepare<[string], { entry: string }>(
          "SELECT entry FROM transactions WHERE location != ? AND location LIKE 'project:%'",
        )
        .all(location)
        .some(row => {
          const entry = entrySchema.parse(JSON.parse(row.entry));
          return !entry.retired && join(dirname(dirname(entry.root)), entry.directory) === destination;
        }),
    );
  }
  async write(entry: SkillTransaction, signal?: AbortSignal): Promise<void> {
    await this.use(db => {
      signal?.throwIfAborted();
      db.prepare('INSERT OR REPLACE INTO transactions VALUES (?, ?, ?, ?)').run(
        entry.id,
        entry.root,
        entry.location,
        JSON.stringify(entry),
      );
    });
  }
  async finish(id: string): Promise<void> {
    await this.use(db => db.prepare('DELETE FROM transactions WHERE id = ?').run(id));
  }
  private async use<T>(operation: (db: Database.Database) => T): Promise<T> {
    const path = join(await privateSkillDirectory(this.metadata, this.userDirectory), 'journal.sqlite');
    await inspectPrivateDatabase(this.metadata, path, 'journal');
    for (const suffix of ['-journal', '-shm', '-wal']) {
      try {
        await inspectPrivateDatabase(this.metadata, path + suffix, 'sidecar');
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
      }
    }
    const db = new Database(path);
    try {
      db.exec(
        'PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, root TEXT NOT NULL, location TEXT NOT NULL, entry TEXT NOT NULL)',
      );
      return operation(db);
    } finally {
      db.close();
    }
  }
}
