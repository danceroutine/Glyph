import Database from 'better-sqlite3';
import { join } from 'node:path';
import { z } from 'zod';
import { optionalStat, privateSkillDirectory } from './SkillPackageStorage.ts';

const entrySchema = z
  .object({
    id: z.uuid(),
    root: z.string(),
    location: z.string(),
    directory: z.string(),
    skillId: z.string(),
    expected: z.string().nullable(),
    replacement: z.string().nullable(),
    source: z.string().nullable(),
    published: z.boolean(),
    retired: z.boolean().default(false),
  })
  .strict();
export type SkillTransaction = z.infer<typeof entrySchema>;

/** Only host-owned user storage describes recoverable transactions. Workspace directory names cannot initiate recovery. */
export class SkillTransactionJournal {
  constructor(private readonly userDirectory: string) {}
  async entries(root: string, location: string): Promise<SkillTransaction[]> {
    if (!(await optionalStat(join(this.userDirectory, '.skill-staging', 'journal.sqlite')))) return [];
    return this.use(db =>
      db
        .prepare<[string, string], { entry: string }>('SELECT entry FROM transactions WHERE root = ? AND location = ?')
        .all(root, location)
        .map(row => entrySchema.parse(JSON.parse(row.entry))),
    );
  }
  async write(entry: SkillTransaction): Promise<void> {
    await this.use(db =>
      db
        .prepare('INSERT OR REPLACE INTO transactions VALUES (?, ?, ?, ?)')
        .run(entry.id, entry.root, entry.location, JSON.stringify(entry)),
    );
  }
  async finish(id: string): Promise<void> {
    await this.use(db => db.prepare('DELETE FROM transactions WHERE id = ?').run(id));
  }
  private async use<T>(operation: (db: Database.Database) => T): Promise<T> {
    const path = join(await privateSkillDirectory(this.userDirectory), 'journal.sqlite');
    const existing = await optionalStat(path);
    if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('Invalid skill transaction journal.');
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
