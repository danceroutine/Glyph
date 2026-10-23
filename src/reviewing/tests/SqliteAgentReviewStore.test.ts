import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { AgentReviewScope, AgentReviewStatus } from '#src/reviewing/AgentReview.js';
import { SqliteAgentReviewStore } from '#src/reviewing/SqliteAgentReviewStore.js';

describe(SqliteAgentReviewStore, () => {
  describe(SqliteAgentReviewStore.prototype.save, () => {
    it('rejects saves before the store is loaded', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const store = new SqliteAgentReviewStore(join(directory, 'reviews.sqlite'));
      const createdAt = new Date().toISOString();

      await expect(
        store.save({
          id: '00000000-0000-4000-8000-000000000000',
          repositoryUri: 'file:///workspace',
          scope: AgentReviewScope.LAST_COMMIT,
          branch: '',
          label: 'Last commit',
          files: [
            {
              path: 'file.ts',
              uri: 'file:///workspace/file.ts',
              before: '',
              after: 'x',
              contextText: '',
              revision: 'r',
            },
          ],
          accountProvider: 'fixture',
          accountId: 'account',
          model: 'test-model',
          status: AgentReviewStatus.RUNNING,
          createdAt,
          updatedAt: createdAt,
          findings: [],
          dismissedIds: [],
          summary: '',
        }),
      ).rejects.toThrow('Review storage is not open.');
    });
  });

  describe(SqliteAgentReviewStore.prototype.dispose, () => {
    it('can be disposed before it was loaded', async () => {
      const store = new SqliteAgentReviewStore(join(tmpdir(), 'never-opened.sqlite'));

      await expect(store.dispose()).resolves.toBeUndefined();
    });
  });
});
