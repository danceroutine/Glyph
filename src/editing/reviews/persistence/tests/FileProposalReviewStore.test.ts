import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileProposalReviewStore } from '#src/editing/reviews/persistence/FileProposalReviewStore.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, link: vi.fn(fs.link) };
});

describe(FileProposalReviewStore, () => {
  it('isolates mutation scopes, imports matching legacy reviews, and never resurrects a cleared checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-scoped-reviews-'));
    const proposal = EditProposal.from({
      schemaVersion: 1,
      id: 'pending',
      source: 'structured',
      createdAt: '2026-10-12T00:00:00Z',
      files: [],
      acknowledgedResultIds: [],
    });
    try {
      await new FileProposalReviewStore(directory).save([proposal], 'original-scope');
      const legacyPath = join(directory, 'active-proposal-review.json');
      const legacy = await readFile(legacyPath, 'utf8');
      const changed = new FileProposalReviewStore(directory, { mutationScope: 'changed-scope' });
      await expect(changed.load('changed-scope')).resolves.toEqual([]);
      await changed.save([EditProposal.from({ ...proposal.toRecord(), id: 'new-scope-review' })], 'changed-scope');
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

  it('honors a concurrent clear while importing historical routes from the unscoped backup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-review-scope-upgrade-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const route = 'root@file%3A%2F%2F%2Fproject%2Flib/notes.txt';
    const snapshot = { path: route, text: 'notes', byteLength: 5, byteOrderMark: false, revision: 'old', mode: 0o644 };
    const file = {
      id: 'notes',
      operation: 'UPDATE',
      sourcePath: route,
      targetPath: route,
      base: snapshot,
      currentPath: route,
      currentRevision: 'old',
      proposed: snapshot,
      items: [],
      applicability: 'READY',
    };
    const oldCheckpoint = {
      schemaVersion: 3,
      workspaceIdentity: 'previous',
      proposals: [{ ...pendingProposal().toRecord(), files: [file] }],
    };
    await writeFile(join(directory, 'active-proposal-review.json'), JSON.stringify(oldCheckpoint));
    const currentDirectory = join(directory, 'mutation-scopes', createHash('sha256').update('current').digest('hex'));
    const currentCheckpoint = { schemaVersion: 3, workspaceIdentity: 'current', proposals: [] };
    let migrated = false;
    const store = new FileProposalReviewStore(directory, {
      mutationScope: 'current',
      previousScope: {
        identity: 'previous',
        restorePath: () => {
          if (!migrated) {
            migrated = true;
            mkdirSync(currentDirectory, { recursive: true });
            writeFileSync(join(currentDirectory, 'active-proposal-review.json'), JSON.stringify(currentCheckpoint), {
              flag: 'wx',
            });
          }
          return 'lib/notes.txt';
        },
      },
    });
    expect(await store.load('current')).toEqual([]);
    expect(migrated).toBe(true);
    expect(await readdir(currentDirectory)).toEqual(['active-proposal-review.json']);
    expect(JSON.parse(await readFile(join(currentDirectory, 'active-proposal-review.json'), 'utf8'))).toEqual(
      currentCheckpoint,
    );
  });

  it('surfaces a failed publication of an imported checkpoint and keeps the saved review available for retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-review-import-retry-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const pending = pendingProposal();
    await new FileProposalReviewStore(directory).save([pending], 'owner');
    const store = new FileProposalReviewStore(directory, { mutationScope: 'owner' });
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(store.load('owner')).rejects.toMatchObject({
      reason: 'PERSISTENCE',
      cause: { cause: { code: 'ENOSPC' } },
    });
    await expect(store.load('owner')).resolves.toEqual([pending]);
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
      await writeFile(path, JSON.stringify({ schemaVersion: 2, workspaceIdentity: 'owner', proposals: [] }));
      await expect(
        new FileProposalReviewStore(directory, { mutationScope: 'owner' }).load('owner'),
      ).rejects.toMatchObject({ cause: { message: 'Unsupported proposal-review checkpoint schema.' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe(FileProposalReviewStore.prototype.load, () => {
    it('loads nothing when no checkpoint has been saved', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-empty-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));

      await expect(new FileProposalReviewStore(directory).load('workspace')).resolves.toEqual([]);
      await expect(
        new FileProposalReviewStore(directory, { mutationScope: 'workspace' }).load('workspace'),
      ).resolves.toEqual([]);
    });

    it('reports an unreadable checkpoint as a persistence failure', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-unreadable-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      await mkdir(join(directory, 'active-proposal-review.json'));

      await expect(new FileProposalReviewStore(directory).load('workspace')).rejects.toMatchObject({
        reason: 'PERSISTENCE',
        message: 'Could not load the active proposal reviews.',
        cause: expect.objectContaining({ code: 'EISDIR' }),
      });
    });

    it('fills defaults for reviews saved by older versions', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-defaults-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const snapshot = {
        path: 'file.txt',
        text: 'base\n',
        byteOrderMark: false,
        revision: 'base-revision',
        byteLength: 5,
        mode: 0o644,
      };
      await writeFile(
        join(directory, 'active-proposal-review.json'),
        JSON.stringify({
          schemaVersion: 3,
          workspaceIdentity: 'workspace',
          proposals: [
            {
              schemaVersion: 1,
              id: 'legacy',
              source: 'patch',
              createdAt: '2026-10-12T00:00:00Z',
              files: [
                {
                  id: 'file',
                  operation: 'UPDATE',
                  sourcePath: 'file.txt',
                  targetPath: 'file.txt',
                  base: snapshot,
                  proposed: { ...snapshot, text: 'next\n', revision: 'next-revision', identity: 'proposed:file.txt' },
                  items: [],
                  applicability: 'READY',
                  currentPath: 'file.txt',
                  currentRevision: 'base-revision',
                },
              ],
            },
          ],
        }),
      );

      const [proposal] = await new FileProposalReviewStore(directory).load('workspace');

      expect(proposal).toEqual({
        schemaVersion: 1,
        id: 'legacy',
        source: 'patch',
        createdAt: '2026-10-12T00:00:00Z',
        acknowledgedResultIds: [],
        files: [
          {
            id: 'file',
            operation: 'UPDATE',
            sourcePath: 'file.txt',
            targetPath: 'file.txt',
            base: { ...snapshot, identity: 'legacy:file.txt' },
            proposed: { ...snapshot, text: 'next\n', revision: 'next-revision', identity: 'proposed:file.txt' },
            current: { ...snapshot, identity: 'legacy:file.txt' },
            items: [],
            applyingItemId: null,
            createdDirectories: [],
            applicability: 'READY',
            currentPath: 'file.txt',
            currentRevision: 'base-revision',
          },
        ],
      });
    });
  });

  describe(FileProposalReviewStore.prototype.save, () => {
    it('reports a checkpoint that cannot replace the existing entry as a persistence failure', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-save-failure-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      await mkdir(join(directory, 'active-proposal-review.json', 'occupied'), { recursive: true });

      await expect(new FileProposalReviewStore(directory).save([pendingProposal()], 'workspace')).rejects.toMatchObject(
        {
          reason: 'PERSISTENCE',
          message: 'Could not persist the active proposal reviews.',
        },
      );
      expect(await readdir(directory)).toEqual(['active-proposal-review.json']);
    });

    it('surfaces a cleanup failure when the storage directory is not a directory', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-review-store-file-directory-'));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, 'reviews'), 'not a directory');

      await expect(
        new FileProposalReviewStore(join(root, 'reviews')).save([pendingProposal()], 'workspace'),
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
    });
  });

  describe(FileProposalReviewStore.prototype.clear, () => {
    it('succeeds when there is no checkpoint to remove', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-clear-missing-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));

      await expect(new FileProposalReviewStore(directory).clear()).resolves.toBeUndefined();
    });

    it('removes a saved checkpoint when saving no reviews', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-clear-empty-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      const store = new FileProposalReviewStore(directory);
      await store.save([pendingProposal()], 'workspace');

      await store.save([], 'workspace');

      expect(await readdir(directory)).toEqual([]);
    });

    it('reports a checkpoint that cannot be removed as a persistence failure', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-review-store-clear-failure-'));
      onTestFinished(() => rm(directory, { recursive: true, force: true }));
      await mkdir(join(directory, 'active-proposal-review.json'));

      await expect(new FileProposalReviewStore(directory).clear()).rejects.toMatchObject({
        reason: 'PERSISTENCE',
        message: 'Could not clear the settled proposal reviews.',
      });
    });
  });
});

function pendingProposal(): EditProposal {
  return EditProposal.from({
    schemaVersion: 1,
    id: 'pending',
    source: 'structured',
    createdAt: '2026-10-12T00:00:00Z',
    files: [],
    acknowledgedResultIds: [],
  });
}
