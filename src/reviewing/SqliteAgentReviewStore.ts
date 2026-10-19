import { mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentReview } from './AgentReview.ts';
import type { AgentReviewStore } from './AgentReviewStore.ts';
import { agentReviewSchema } from './AgentReviewSchema.ts';

/** Workspace-scoped atomic checkpoints, including the exact reviewed revisions. */
export class SqliteAgentReviewStore implements AgentReviewStore {
  private db: Database.Database | undefined;
  constructor(private readonly path: string) {}
  async load(): Promise<readonly AgentReview[]> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new Database(this.path);
    await chmod(this.path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS agent_reviews (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record TEXT NOT NULL)',
    );
    return this.db
      .prepare('SELECT record FROM agent_reviews ORDER BY updated_at')
      .all()
      .map(row => {
        const { record } = row as { record: string };
        return agentReviewSchema.parse(JSON.parse(record));
      });
  }
  async save(review: AgentReview): Promise<void> {
    if (!this.db) throw new Error('Review storage is not open.');
    const value = agentReviewSchema.parse(review);
    this.db
      .prepare('INSERT OR REPLACE INTO agent_reviews (id, updated_at, record) VALUES (?, ?, ?)')
      .run(value.id, value.updatedAt, JSON.stringify(value));
  }
  async dispose(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
