import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';

describe(FileProposalReviewStore, () => {
  it('isolates mutation scopes, imports matching legacy reviews, and never resurrects a cleared checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-scoped-reviews-'));
    const proposal: EditProposal = {
      schemaVersion: 1,
      id: 'pending',
      source: 'structured',
      createdAt: '2026-10-12T00:00:00Z',
      files: [],
      acknowledgedResultIds: [],
    };
    try {
      await new FileProposalReviewStore(directory).save([proposal], 'original-scope');
      const legacyPath = join(directory, 'active-proposal-review.json');
      const legacy = await readFile(legacyPath, 'utf8');
      const changed = new FileProposalReviewStore(directory, { mutationScope: 'changed-scope' });
      await expect(changed.load('changed-scope')).resolves.toEqual([]);
      await changed.save([{ ...proposal, id: 'new-scope-review' }], 'changed-scope');
      const original = new FileProposalReviewStore(directory, { mutationScope: 'original-scope' });
      await expect(original.load('original-scope')).resolves.toEqual([proposal]);
      await original.clear();
      await expect(
        new FileProposalReviewStore(directory, { mutationScope: 'original-scope' }).load('original-scope'),
      ).resolves.toEqual([]);
      await expect(changed.load('changed-scope')).resolves.toMatchObject([{ id: 'new-scope-review' }]);
      expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a foreign checkpoint inside an already scoped directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-scoped-review-binding-'));
    try {
      const store = new FileProposalReviewStore(directory, { mutationScope: 'owner' });
      await store.save([], 'owner');
      const [scope] = await readdir(join(directory, 'mutation-scopes'));
      const path = join(directory, 'mutation-scopes', scope!, 'active-proposal-review.json');
      await writeFile(path, JSON.stringify({ schemaVersion: 3, workspaceIdentity: 'other', proposals: [] }));
      await expect(store.load('owner')).rejects.toMatchObject({ reason: 'PERSISTENCE' });
      await expect(store.save([], 'other')).rejects.toMatchObject({ reason: 'PERSISTENCE' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports corrupt legacy storage instead of silently discarding it during migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-scoped-review-corruption-'));
    try {
      const path = join(directory, 'active-proposal-review.json');
      await writeFile(path, '{truncated checkpoint');
      await expect(
        new FileProposalReviewStore(directory, { mutationScope: 'owner' }).load('owner'),
      ).rejects.toMatchObject({ reason: 'PERSISTENCE' });
      expect(await readFile(path, 'utf8')).toBe('{truncated checkpoint');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
