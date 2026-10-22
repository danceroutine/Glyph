import { describe, expect, it, vi } from 'vitest';
import { URI } from '#vs/base/common/uri.js';
import type { ISCMRepository } from '#vs/workbench/contrib/scm/common/scm.js';
import type { GlyphIdeContext } from '#vs/workbench/contrib/glyph/browser/GlyphIdeContext.js';
import { GlyphAgentReviewScope as Scope } from '#glyph/workbench/GlyphAgentReview.js';
import {
  captureGlyphAgentReview,
  glyphAgentReviewUnavailableReason,
} from '#vs/workbench/contrib/glyph/browser/GlyphAgentReviewCapture.js';

interface FakeResource {
  sourceUri: URI;
  multiDiffEditorOriginalUri?: URI;
  multiDiffEditorModifiedUri?: URI;
}
interface FakeGroup {
  id: string;
  resources: FakeResource[];
}

const gitUri = (path: string, query: Record<string, string>) =>
  URI.file(path).with({ scheme: 'git', query: JSON.stringify({ path, ...query }) });

const historyOf = (revision: string | undefined) => ({
  historyItemRef: { get: () => (revision === undefined ? undefined : { revision }) },
  resolveHistoryItem: vi.fn(async (_id: string): Promise<{ parentIds: string[] } | undefined> => ({
    parentIds: ['parent'],
  })),
  provideHistoryItemChanges: vi.fn(
    async (_head: string, _base: string | undefined): Promise<{ uri: URI; originalUri?: URI; modifiedUri?: URI }[]> => [
      {
        uri: URI.file('/repo/a.ts'),
        originalUri: gitUri('/repo/a.ts', { ref: 'parent' }),
        modifiedUri: URI.file('/repo/a.ts'),
      },
    ],
  ),
  provideHistoryItemRefs: vi.fn(
    async (_ids?: string[]): Promise<{ id: string; name: string; revision?: string }[] | undefined> => [
      { id: 'refs/heads/main', name: 'main', revision: 'main-tip' },
    ],
  ),
  resolveHistoryItemRefsCommonAncestor: vi.fn(async (_refs: string[]): Promise<string | undefined> => 'ancestor'),
});

const repositoryOf = (history: unknown, groups: FakeGroup[] = []) =>
  ({ provider: { historyProvider: { get: () => history }, groups } }) as unknown as ISCMRepository;

const ideOf = (revision = (uri: URI) => `rev:${uri.toString()}`) => {
  const captureDiff = vi.fn(
    async (
      uri: URI,
      before: URI | undefined,
      after: URI | undefined,
      label: string,
      captured?: (b: string, a: string) => void,
    ) => {
      captured?.(`before:${before?.toString() ?? ''}`, `after:${after?.toString() ?? ''}`);
      return { kind: 'diff', uri: uri.toString(), path: uri.path, text: label, contentRevision: revision(uri) };
    },
  );
  return { ide: { captureDiff } as unknown as GlyphIdeContext, captureDiff };
};

describe(glyphAgentReviewUnavailableReason, () => {
  it('requires a commit for history-based scopes', () => {
    expect(glyphAgentReviewUnavailableReason(repositoryOf(undefined), Scope.LAST_COMMIT)).toBe(
      'Git history is unavailable. Create a commit to review.',
    );
    expect(glyphAgentReviewUnavailableReason(repositoryOf(historyOf(undefined)), Scope.BRANCH)).toBe(
      'Git history is unavailable. Create a commit to review.',
    );
    expect(glyphAgentReviewUnavailableReason(repositoryOf(historyOf('')), Scope.BRANCH)).toBe(
      'Git history is unavailable. Create a commit to review.',
    );
    expect(glyphAgentReviewUnavailableReason(repositoryOf(historyOf('head')), Scope.LAST_COMMIT)).toBeUndefined();
  });

  it('blocks all local changes while merge conflicts remain', () => {
    const conflicted = repositoryOf(historyOf('head'), [
      { id: 'merge', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
      { id: 'index', resources: [{ sourceUri: URI.file('/repo/b.ts') }] },
    ]);

    expect(glyphAgentReviewUnavailableReason(conflicted, Scope.ALL_LOCAL)).toBe(
      'Resolve merge conflicts before reviewing all local changes.',
    );
    expect(glyphAgentReviewUnavailableReason(conflicted, Scope.STAGED)).toBeUndefined();
  });

  it('requires changes in the selected local scope', () => {
    const working = repositoryOf(undefined, [
      { id: 'merge', resources: [] },
      { id: 'index', resources: [] },
      { id: 'workingTree', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
    ]);
    const untracked = repositoryOf(undefined, [
      { id: 'untracked', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
    ]);
    const other = repositoryOf(undefined, [{ id: 'other', resources: [{ sourceUri: URI.file('/repo/a.ts') }] }]);

    expect(glyphAgentReviewUnavailableReason(working, Scope.STAGED)).toBe(
      'There are no changes in the selected review scope.',
    );
    expect(glyphAgentReviewUnavailableReason(working, Scope.ALL_LOCAL)).toBeUndefined();
    expect(glyphAgentReviewUnavailableReason(untracked, Scope.ALL_LOCAL)).toBeUndefined();
    expect(glyphAgentReviewUnavailableReason(other, Scope.ALL_LOCAL)).toBe(
      'There are no changes in the selected review scope.',
    );
  });
});

describe(captureGlyphAgentReview, () => {
  it('refuses scopes that are unavailable', async () => {
    const { ide } = ideOf();

    await expect(captureGlyphAgentReview(ide, repositoryOf(undefined), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'Git history is unavailable. Create a commit to review.',
    );
  });

  it('refuses history that disappears after the availability check', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    let reads = 0;
    const repository = {
      provider: { historyProvider: { get: () => (reads++ ? undefined : history) }, groups: [] },
    } as unknown as ISCMRepository;

    await expect(captureGlyphAgentReview(ide, repository, Scope.LAST_COMMIT, '')).rejects.toThrow(
      'Git history is unavailable. Create a commit to review.',
    );
  });

  it('reviews the last commit against its first parent', async () => {
    const { ide, captureDiff } = ideOf();
    const history = historyOf('head');
    const captured = vi.fn<NonNullable<Parameters<typeof captureGlyphAgentReview>[4]>>();

    const attachments = await captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '', captured);

    expect(history.provideHistoryItemChanges).toHaveBeenCalledWith('head', 'parent');
    expect(attachments).toEqual([expect.objectContaining({ text: 'Last commit: parent → head' })]);
    expect(captureDiff).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0].toString()).toBe(URI.file('/repo/a.ts').toString());
    expect(captured).toHaveBeenCalledWith(
      expect.anything(),
      `before:${gitUri('/repo/a.ts', { ref: 'parent' }).toString()}`,
      `after:${URI.file('/repo/a.ts').toString()}`,
    );
  });

  it('reviews an initial commit against the empty tree', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.resolveHistoryItem.mockResolvedValue({ parentIds: [] });

    const attachments = await captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '');

    expect(history.provideHistoryItemChanges).toHaveBeenCalledWith('head', undefined);
    expect(attachments[0].text).toBe('Last commit: empty tree → head');
  });

  it('reports a last commit that cannot be resolved', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.resolveHistoryItem.mockResolvedValue(undefined);

    await expect(captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'The last commit could not be resolved.',
    );
  });

  it('reports a comparison that Git does not provide', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.provideHistoryItemChanges.mockResolvedValue(undefined as never);

    await expect(captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'Git did not provide the selected comparison.',
    );
  });

  it('compares against the merge base of the chosen branch', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');

    const attachments = await captureGlyphAgentReview(ide, repositoryOf(history), Scope.BRANCH, 'refs/heads/main');

    expect(history.provideHistoryItemRefs).toHaveBeenCalledWith(['refs/heads/main']);
    expect(history.resolveHistoryItemRefsCommonAncestor).toHaveBeenCalledWith(['head', 'main-tip']);
    expect(history.provideHistoryItemChanges).toHaveBeenCalledWith('head', 'ancestor');
    expect(attachments[0].text).toBe('Branch comparison: refs/heads/main at main-tip; merge base ancestor → head');
  });

  it('requires a base branch', async () => {
    const { ide } = ideOf();

    await expect(captureGlyphAgentReview(ide, repositoryOf(historyOf('head')), Scope.BRANCH, '')).rejects.toThrow(
      'Choose a base branch before reviewing.',
    );
  });

  it('reports a base branch that is missing or has no revision', async () => {
    const { ide } = ideOf();
    const missing = historyOf('head');
    missing.provideHistoryItemRefs.mockResolvedValue(undefined);
    const unrelated = historyOf('head');
    unrelated.provideHistoryItemRefs.mockResolvedValue([{ id: 'refs/heads/other', name: 'other', revision: 'x' }]);
    const unresolved = historyOf('head');
    unresolved.provideHistoryItemRefs.mockResolvedValue([{ id: 'refs/heads/main', name: 'main' }]);

    for (const history of [missing, unrelated, unresolved])
      await expect(
        captureGlyphAgentReview(ide, repositoryOf(history), Scope.BRANCH, 'refs/heads/main'),
      ).rejects.toThrow('The selected base branch is unavailable. Choose it again.');
  });

  it('reports branches without a common ancestor', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.resolveHistoryItemRefsCommonAncestor.mockResolvedValue(undefined);

    await expect(captureGlyphAgentReview(ide, repositoryOf(history), Scope.BRANCH, 'refs/heads/main')).rejects.toThrow(
      'The branches have no available common ancestor.',
    );
  });

  it('compares staged changes from HEAD to the index', async () => {
    const { ide, captureDiff } = ideOf();
    const head = gitUri('/repo/a.ts', { ref: 'HEAD' });
    const index = gitUri('/repo/a.ts', { ref: '' });
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorOriginalUri: head, multiDiffEditorModifiedUri: index },
        ],
      },
      {
        id: 'workingTree',
        resources: [{ sourceUri: URI.file('/repo/b.ts'), multiDiffEditorModifiedUri: URI.file('/repo/b.ts') }],
      },
    ]);

    const attachments = await captureGlyphAgentReview(ide, repository, Scope.STAGED, '');

    expect(attachments).toHaveLength(1);
    expect(attachments[0].text).toBe('Staged changes: head → index');
    const [uri, original, modified] = captureDiff.mock.calls[0];
    expect(uri.toString()).toBe(URI.file('/repo/a.ts').toString());
    expect(JSON.parse(original!.query)).toEqual({ path: '/repo/a.ts', ref: 'head' });
    expect(modified).toBe(index);
    expect(captureDiff).toHaveBeenCalledTimes(2);
  });

  it('compares staged changes from the empty tree before the first commit', async () => {
    const { ide, captureDiff } = ideOf();
    const original = gitUri('/repo/a.ts', { ref: 'HEAD' });
    const repository = repositoryOf(undefined, [
      {
        id: 'index',
        resources: [
          {
            sourceUri: URI.file('/repo/a.ts'),
            multiDiffEditorOriginalUri: original,
            multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }),
          },
        ],
      },
    ]);

    const attachments = await captureGlyphAgentReview(ide, repository, Scope.STAGED, '');

    expect(attachments[0].text).toBe('Staged changes: empty tree → index');
    expect(captureDiff.mock.calls[0][1]).toBe(original);
  });

  it('compares all local changes from HEAD to the working tree', async () => {
    const { ide, captureDiff } = ideOf();
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          {
            sourceUri: URI.file('/repo/a.ts'),
            multiDiffEditorOriginalUri: gitUri('/repo/a.ts', { ref: 'HEAD' }),
            multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }),
          },
        ],
      },
      {
        id: 'workingTree',
        resources: [
          {
            sourceUri: URI.file('/repo/a.ts'),
            multiDiffEditorOriginalUri: gitUri('/repo/a.ts', { ref: '' }),
            multiDiffEditorModifiedUri: URI.file('/repo/a.ts'),
          },
          { sourceUri: URI.file('/repo/gone.ts'), multiDiffEditorOriginalUri: gitUri('/repo/gone.ts', { ref: '' }) },
        ],
      },
      {
        id: 'untracked',
        resources: [{ sourceUri: URI.file('/repo/new.ts'), multiDiffEditorModifiedUri: URI.file('/repo/new.ts') }],
      },
    ]);

    const attachments = await captureGlyphAgentReview(ide, repository, Scope.ALL_LOCAL, '');

    expect(attachments.map(attachment => attachment.uri)).toEqual([
      URI.file('/repo/a.ts').toString(),
      URI.file('/repo/gone.ts').toString(),
      URI.file('/repo/new.ts').toString(),
    ]);
    expect(attachments[0].text).toBe(
      'All local changes: head → working tree (includes unsaved text for changed files)',
    );
    const calls = captureDiff.mock.calls
      .slice(0, 3)
      .map(([, original, modified]) => [
        original && (JSON.parse(original.query || '{}') as unknown),
        modified?.toString(),
      ]);
    expect(calls).toEqual([
      [{ path: '/repo/a.ts', ref: 'head' }, URI.file('/repo/a.ts').toString()],
      [{ path: '/repo/gone.ts', ref: 'head' }, undefined],
      [undefined, URI.file('/repo/new.ts').toString()],
    ]);
  });

  it('describes all local changes before the first commit', async () => {
    const { ide } = ideOf();
    const repository = repositoryOf(undefined, [
      {
        id: 'untracked',
        resources: [{ sourceUri: URI.file('/repo/new.ts'), multiDiffEditorModifiedUri: URI.file('/repo/new.ts') }],
      },
    ]);

    const attachments = await captureGlyphAgentReview(ide, repository, Scope.ALL_LOCAL, '');

    expect(attachments[0].text).toBe(
      'All local changes: empty tree → working tree (includes unsaved text for changed files)',
    );
  });

  it('skips staged additions that were deleted from the working tree', async () => {
    const { ide } = ideOf();
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
      {
        id: 'workingTree',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorOriginalUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
      {
        id: 'untracked',
        resources: [{ sourceUri: URI.file('/repo/b.ts'), multiDiffEditorModifiedUri: URI.file('/repo/b.ts') }],
      },
    ]);

    const attachments = await captureGlyphAgentReview(ide, repository, Scope.ALL_LOCAL, '');

    expect(attachments.map(attachment => attachment.uri)).toEqual([URI.file('/repo/b.ts').toString()]);
  });

  it('reports a scope whose only change has no net difference', async () => {
    const { ide } = ideOf();
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
      {
        id: 'workingTree',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorOriginalUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
    ]);

    await expect(captureGlyphAgentReview(ide, repository, Scope.ALL_LOCAL, '')).rejects.toThrow(
      'There are no changes in the selected review scope.',
    );
  });

  it('reports changes that expose no text comparison', async () => {
    const { ide } = ideOf();
    const staged = repositoryOf(historyOf('head'), [
      { id: 'index', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
    ]);
    const working = repositoryOf(historyOf('head'), [
      { id: 'index', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
      { id: 'workingTree', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
    ]);
    const addition = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
      { id: 'workingTree', resources: [{ sourceUri: URI.file('/repo/a.ts') }] },
    ]);

    await expect(captureGlyphAgentReview(ide, staged, Scope.STAGED, '')).rejects.toThrow(
      `Git did not expose a text comparison for ${URI.file('/repo/a.ts').fsPath}.`,
    );
    await expect(captureGlyphAgentReview(ide, working, Scope.ALL_LOCAL, '')).rejects.toThrow(
      `Git did not expose a text comparison for ${URI.file('/repo/a.ts').fsPath}.`,
    );
    await expect(captureGlyphAgentReview(ide, addition, Scope.ALL_LOCAL, '')).rejects.toThrow(
      `Git did not expose a text comparison for ${URI.file('/repo/a.ts').fsPath}.`,
    );
  });

  it('refuses submodule changes', async () => {
    const { ide } = ideOf();
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          {
            sourceUri: URI.file('/repo/sub'),
            multiDiffEditorOriginalUri: gitUri('/repo/sub', { ref: 'HEAD', submoduleOf: '/repo' }),
          },
        ],
      },
    ]);

    await expect(captureGlyphAgentReview(ide, repository, Scope.STAGED, '')).rejects.toThrow(
      'Submodule changes require a review in the submodule repository.',
    );
  });

  it('reports a history comparison without changes', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.provideHistoryItemChanges.mockResolvedValue([]);

    await expect(captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'There are no changes in the selected review scope.',
    );
  });

  it('refuses reviews of more than 32 files', async () => {
    const { ide } = ideOf();
    const history = historyOf('head');
    history.provideHistoryItemChanges.mockResolvedValue(
      Array.from({ length: 33 }, (_, index) => ({
        uri: URI.file(`/repo/${index}.ts`),
        modifiedUri: URI.file(`/repo/${index}.ts`),
      })),
    );

    await expect(captureGlyphAgentReview(ide, repositoryOf(history), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'This review exceeds 32 changed files. Select a smaller scope.',
    );
  });

  it('refuses reviews larger than 2 MiB', async () => {
    const captureDiff = vi.fn(async (uri: URI) => ({
      uri: uri.toString(),
      path: uri.path,
      text: 'x'.repeat(2 * 1024 * 1024 + 1),
      contentRevision: 'r',
    }));
    const ide = { captureDiff } as unknown as GlyphIdeContext;

    await expect(captureGlyphAgentReview(ide, repositoryOf(historyOf('head')), Scope.LAST_COMMIT, '')).rejects.toThrow(
      'This review exceeds 2 MiB. Select a smaller scope.',
    );
  });

  it('refuses captures during which HEAD moved', async () => {
    let revision = 'head';
    const history = { ...historyOf('head'), historyItemRef: { get: () => ({ revision }) } };
    const captureDiff = vi.fn(async (uri: URI) => {
      revision = 'moved';
      return { uri: uri.toString(), path: uri.path, text: '', contentRevision: 'r' };
    });

    await expect(
      captureGlyphAgentReview(
        { captureDiff } as unknown as GlyphIdeContext,
        repositoryOf(history),
        Scope.LAST_COMMIT,
        '',
      ),
    ).rejects.toThrow('Git changed during capture. Start the review again.');
  });

  it.each([Scope.LAST_COMMIT, Scope.BRANCH])(
    'reviews %s history while unrelated working tree files appear during capture',
    async scope => {
      const groups: FakeGroup[] = [{ id: 'workingTree', resources: [] }];
      const captureDiff = vi.fn(async (uri: URI) => {
        groups[0].resources.push({ sourceUri: URI.file('/repo/.vscode/settings.json') });
        return { uri: uri.toString(), path: uri.path, text: '', contentRevision: 'r' };
      });

      const captured = await captureGlyphAgentReview(
        { captureDiff } as unknown as GlyphIdeContext,
        repositoryOf(historyOf('head'), groups),
        scope,
        'refs/heads/main',
      );

      expect(captured.map(value => value.uri)).toEqual([URI.file('/repo/a.ts').toString()]);
    },
  );

  it('refuses captures during which the changed files moved', async () => {
    const groups: FakeGroup[] = [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
    ];
    const captureDiff = vi.fn(async (uri: URI) => {
      groups.push({ id: 'workingTree', resources: [{ sourceUri: URI.file('/repo/b.ts') }] });
      return { uri: uri.toString(), path: uri.path, text: '', contentRevision: 'r' };
    });

    await expect(
      captureGlyphAgentReview(
        { captureDiff } as unknown as GlyphIdeContext,
        repositoryOf(historyOf('head'), groups),
        Scope.STAGED,
        '',
      ),
    ).rejects.toThrow('Git changed during capture. Start the review again.');
  });

  it('refuses local captures whose files were edited during capture', async () => {
    let edits = 0;
    const { ide } = ideOf(() => `rev:${edits++}`);
    const repository = repositoryOf(historyOf('head'), [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
    ]);

    await expect(captureGlyphAgentReview(ide, repository, Scope.STAGED, '')).rejects.toThrow(
      'A changed file was edited during capture. Start the review again.',
    );
  });

  it('refuses local captures during which HEAD moved while verifying', async () => {
    let revision = 'head';
    let calls = 0;
    const history = { ...historyOf('head'), historyItemRef: { get: () => ({ revision }) } };
    const captureDiff = vi.fn(async (uri: URI) => {
      if (calls++) revision = 'moved';
      return { uri: uri.toString(), path: uri.path, text: '', contentRevision: 'r' };
    });
    const repository = repositoryOf(history, [
      {
        id: 'index',
        resources: [
          { sourceUri: URI.file('/repo/a.ts'), multiDiffEditorModifiedUri: gitUri('/repo/a.ts', { ref: '' }) },
        ],
      },
    ]);

    await expect(
      captureGlyphAgentReview({ captureDiff } as unknown as GlyphIdeContext, repository, Scope.STAGED, ''),
    ).rejects.toThrow('Git changed during capture. Start the review again.');
  });
});
