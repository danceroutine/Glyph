import { build } from 'esbuild';
import { resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import { importBundle } from '#scripts/code-oss/tests/support/bundle.mjs';

/**
 * @typedef {import('#vs/base/common/uri.js').URI} URIValue
 * @typedef {{
 *   captureGlyphAgentReview: typeof import('#vs/workbench/contrib/glyph/browser/GlyphAgentReviewCapture.js').captureGlyphAgentReview,
 *   URI: typeof import('#vs/base/common/uri.js').URI,
 * }} CaptureModule
 * @typedef {{ sourceUri: URIValue, multiDiffEditorOriginalUri?: URIValue, multiDiffEditorModifiedUri?: URIValue }} ScmResource
 */

/** @type {CaptureModule['URI']} */
let URI;
/** @type {CaptureModule['captureGlyphAgentReview']} */
let capture;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `export { captureGlyphAgentReview } from './code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphAgentReviewCapture.ts'; export { URI } from '#vs/base/common/uri.js';`,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'aliases',
        setup(builder) {
          builder.onResolve({ filter: /^#vs\// }, args => ({
            path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')),
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  /** @type {CaptureModule} */
  const api = await importBundle(result.outputFiles[0].text, ['captureGlyphAgentReview', 'URI']);
  ({ captureGlyphAgentReview: capture, URI } = api);
});
function fixture() {
  const uri = URI.file('/workspace/a.ts');
  /** @param {string} ref */
  const git = ref => uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
  const change = { uri, originalUri: git('parent'), modifiedUri: git('head') };
  const history = {
    historyItemRef: { get: () => ({ revision: 'head' }) },
    resolveHistoryItem: vi.fn(async () => ({ parentIds: ['parent'] })),
    provideHistoryItemChanges: vi.fn(async () => [change]),
    provideHistoryItemRefs: vi.fn(async () => [{ id: 'refs/heads/main', revision: 'base-tip' }]),
    resolveHistoryItemRefsCommonAncestor: vi.fn(async () => 'ancestor'),
  };
  /** @type {{ id: string, resources: ScmResource[] }[]} */
  const groups = [];
  const repository = { provider: { historyProvider: { get: () => history }, groups } };
  const ide = {
    captureDiff: vi.fn(
      async (
        /** @type {URIValue} */ resource,
        /** @type {URIValue | undefined} */ original,
        /** @type {URIValue | undefined} */ modified,
        /** @type {string} */ label,
      ) => ({
        uri: resource.toString(),
        path: 'a.ts',
        text: label,
        contentRevision: `${String(original)}:${String(modified)}`,
      }),
    ),
  };
  return { uri, git, history, repository, ide };
}
it('reviews the last commit against its first parent, including initial commits', async () => {
  const f = fixture();
  await capture(f.ide, f.repository, 'lastCommit', '');
  expect(f.history.provideHistoryItemChanges).toHaveBeenCalledWith('head', 'parent');
  f.history.resolveHistoryItem.mockResolvedValue({ parentIds: [] });
  await capture(f.ide, f.repository, 'lastCommit', '');
  expect(f.history.provideHistoryItemChanges).toHaveBeenLastCalledWith('head', undefined);
});
it('resolves the chosen branch revision and merge base instead of comparing unrelated tips', async () => {
  const f = fixture();
  await capture(f.ide, f.repository, 'branch', 'refs/heads/main');
  expect(f.history.resolveHistoryItemRefsCommonAncestor).toHaveBeenCalledWith(['head', 'base-tip']);
  expect(f.history.provideHistoryItemChanges).toHaveBeenCalledWith('head', 'ancestor');
});
it('keeps staged and all-local scopes distinct for a file modified in both index and worktree', async () => {
  const f = fixture();
  f.repository.provider.groups = [
    {
      id: 'index',
      resources: [
        { sourceUri: f.uri, multiDiffEditorOriginalUri: f.git('HEAD'), multiDiffEditorModifiedUri: f.git('') },
      ],
    },
    {
      id: 'workingTree',
      resources: [{ sourceUri: f.uri, multiDiffEditorOriginalUri: f.git(''), multiDiffEditorModifiedUri: f.uri }],
    },
  ];
  await capture(f.ide, f.repository, 'staged', '');
  expect(f.ide.captureDiff.mock.calls[0][2].scheme).toBe('git');
  f.ide.captureDiff.mockClear();
  await capture(f.ide, f.repository, 'allLocal', '');
  expect(f.ide.captureDiff.mock.calls[0][2].scheme).toBe('file');
  /** @type {unknown} */
  const query = JSON.parse(f.ide.captureDiff.mock.calls[0][1]?.query ?? '');
  expect(query).toMatchObject({ ref: 'head' });
});
it('does not manufacture a HEAD version for a newly staged file, including staged additions then deletions', async () => {
  const f = fixture();
  f.repository.provider.groups = [
    { id: 'index', resources: [{ sourceUri: f.uri, multiDiffEditorModifiedUri: f.git('') }] },
  ];
  await capture(f.ide, f.repository, 'staged', '');
  expect(f.ide.captureDiff.mock.calls[0][1]).toBeUndefined();
});
it('omits a staged addition deleted from the worktree while retaining unrelated all-local changes', async () => {
  const f = fixture();
  const changed = URI.file('/workspace/changed.ts');
  f.repository.provider.groups = [
    { id: 'index', resources: [{ sourceUri: f.uri, multiDiffEditorModifiedUri: f.git('') }] },
    {
      id: 'workingTree',
      resources: [
        { sourceUri: f.uri, multiDiffEditorOriginalUri: f.git('HEAD') },
        {
          sourceUri: changed,
          multiDiffEditorOriginalUri: changed.with({
            scheme: 'git',
            query: JSON.stringify({ path: changed.fsPath, ref: 'HEAD' }),
          }),
          multiDiffEditorModifiedUri: changed,
        },
      ],
    },
  ];
  const captured = await capture(f.ide, f.repository, 'allLocal', '');
  expect(captured.map(value => value.uri)).toEqual([changed.toString()]);
  expect(f.ide.captureDiff.mock.calls.every(([uri]) => uri.toString() === changed.toString())).toBe(true);
  f.ide.captureDiff.mockClear();
  await capture(f.ide, f.repository, 'staged', '');
  expect(f.ide.captureDiff.mock.calls[0][0].toString()).toBe(f.uri.toString());
  expect(f.ide.captureDiff.mock.calls[0][1]).toBeUndefined();
  expect(f.ide.captureDiff.mock.calls[0][2].toString()).toBe(f.git('').toString());
  f.repository.provider.groups[1].resources.pop();
  await expect(capture(f.ide, f.repository, 'allLocal', '')).rejects.toThrow('no changes');
});
it('rejects oversized reviews and mutable captures that change across the batch', async () => {
  const f = fixture();
  f.history.provideHistoryItemChanges.mockResolvedValue(Array.from({ length: 33 }, () => ({ uri: f.uri })));
  await expect(capture(f.ide, f.repository, 'lastCommit', '')).rejects.toThrow('32');
  f.repository.provider.groups = [
    { id: 'index', resources: [{ sourceUri: f.uri, multiDiffEditorModifiedUri: f.git('') }] },
  ];
  f.ide.captureDiff
    .mockResolvedValueOnce({ text: 'before', contentRevision: 'a' })
    .mockResolvedValueOnce({ text: 'after', contentRevision: 'b' });
  await expect(capture(f.ide, f.repository, 'staged', '')).rejects.toThrow('edited during capture');
});
it('reports missing branches and empty scopes instead of silently choosing another comparison', async () => {
  const f = fixture();
  f.history.provideHistoryItemRefs.mockResolvedValue([]);
  await expect(capture(f.ide, f.repository, 'branch', 'missing')).rejects.toThrow('unavailable');
  await expect(capture(f.ide, f.repository, 'staged', '')).rejects.toThrow('no changes');
});

it('reports unresolved conflicts instead of omitting them from all local changes', async () => {
  const f = fixture();
  f.repository.provider.groups = [{ id: 'merge', resources: [{ sourceUri: f.uri }] }];
  await expect(capture(f.ide, f.repository, 'allLocal', '')).rejects.toThrow('merge conflicts');
  expect(f.ide.captureDiff).not.toHaveBeenCalled();
});
