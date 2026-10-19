import { URI } from '#vs/base/common/uri.js';
import type { ISCMRepository, ISCMResource } from '#vs/workbench/contrib/scm/common/scm.js';
import type { GlyphIdeContext } from './GlyphIdeContext.js';
import { GlyphAgentReviewScope as Scope } from '#glyph/workbench/GlyphAgentReview.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';

/** Check prerequisites exposed by SCM without capturing file contents. */
export function glyphAgentReviewUnavailableReason(repository: ISCMRepository, scope: Scope): string | undefined {
  const provider = repository.provider;
  if (scope === Scope.LAST_COMMIT || scope === Scope.BRANCH) {
    if (!provider.historyProvider.get()?.historyItemRef.get()?.revision)
      return 'Git history is unavailable. Create a commit to review.';
  } else {
    if (scope === Scope.ALL_LOCAL && provider.groups.some(group => group.id === 'merge' && group.resources.length))
      return 'Resolve merge conflicts before reviewing all local changes.';
    const hasChanges = provider.groups.some(
      group =>
        (group.id === 'index' ||
          (scope === Scope.ALL_LOCAL && (group.id === 'workingTree' || group.id === 'untracked'))) &&
        group.resources.length > 0,
    );
    if (!hasChanges) return 'There are no changes in the selected review scope.';
  }
  return undefined;
}

/** Resolve the selected comparison once; never substitute a different scope on failure. */
export async function captureGlyphAgentReview(
  ide: GlyphIdeContext,
  repository: ISCMRepository,
  scope: Scope,
  branch: string,
): Promise<readonly GlyphContextAttachment[]> {
  const unavailableReason = glyphAgentReviewUnavailableReason(repository, scope);
  if (unavailableReason) throw new Error(unavailableReason);
  const provider = repository.provider;
  const history = provider.historyProvider.get();
  const head = history?.historyItemRef.get()?.revision;
  let label: string;
  let changes: { uri: URI; originalUri?: URI; modifiedUri?: URI }[];
  if (scope === Scope.LAST_COMMIT || scope === Scope.BRANCH) {
    if (!history || !head) throw new Error('Git history is unavailable. Create a commit to review.');
    let base: string | undefined;
    if (scope === Scope.LAST_COMMIT) {
      const commit = await history.resolveHistoryItem(head);
      if (!commit) throw new Error('The last commit could not be resolved.');
      base = commit.parentIds[0];
      label = `Last commit: ${base ?? 'empty tree'} → ${head}`;
    } else {
      if (!branch) throw new Error('Choose a base branch before reviewing.');
      const ref = (await history.provideHistoryItemRefs([branch]))?.find(ref => ref.id === branch);
      if (!ref?.revision) throw new Error('The selected base branch is unavailable. Choose it again.');
      base = await history.resolveHistoryItemRefsCommonAncestor([head, ref.revision]);
      if (!base) throw new Error('The branches have no available common ancestor.');
      label = `Branch comparison: ${branch} at ${ref.revision}; merge base ${base} → ${head}`;
    }
    const result = await history.provideHistoryItemChanges(head, base);
    if (!result) throw new Error('Git did not provide the selected comparison.');
    changes = result;
  } else {
    const groups = provider.groups.filter(
      group =>
        group.id === 'index' || (scope === Scope.ALL_LOCAL && (group.id === 'workingTree' || group.id === 'untracked')),
    );
    const grouped = new Map<string, { staged?: ISCMResource; working?: ISCMResource }>();
    for (const group of groups)
      for (const resource of group.resources) {
        const key = resource.sourceUri.toString();
        const item = grouped.get(key) ?? {};
        if (group.id === 'index') item.staged = resource;
        else item.working = resource;
        grouped.set(key, item);
      }
    changes = [...grouped.values()].map(({ staged, working }) => {
      const resource = (working ?? staged)!;
      let originalUri = staged ? staged.multiDiffEditorOriginalUri : resource.multiDiffEditorOriginalUri;
      // All local changes compare HEAD to working text, not index to working text.
      if (originalUri?.scheme === 'git' && head) {
        const query = JSON.parse(originalUri.query) as { ref?: string; submoduleOf?: string };
        if (query.submoduleOf) throw new Error('Submodule changes require a review in the submodule repository.');
        originalUri = originalUri.with({ query: JSON.stringify({ ...query, ref: head }) });
      }
      const modifiedUri =
        scope === Scope.STAGED
          ? staged?.multiDiffEditorModifiedUri
          : resource.multiDiffEditorModifiedUri
            ? resource.sourceUri
            : undefined;
      if (!originalUri && !modifiedUri)
        throw new Error(`Git did not expose a text comparison for ${resource.sourceUri.fsPath}.`);
      return { uri: resource.sourceUri, originalUri, modifiedUri };
    });
    label =
      scope === Scope.STAGED
        ? `Staged changes: ${head ?? 'empty tree'} → index`
        : `All local changes: ${head ?? 'empty tree'} → working tree (includes unsaved text for changed files)`;
  }
  if (!changes.length) throw new Error('There are no changes in the selected review scope.');
  if (changes.length > 32) throw new Error('This review exceeds 32 changed files. Select a smaller scope.');
  const signature = () =>
    provider.groups
      .map(group => `${group.id}:${group.resources.map(resource => resource.sourceUri.toString()).join(',')}`)
      .join('|');
  const before = signature();
  const attachments: GlyphContextAttachment[] = [];
  for (const change of changes)
    attachments.push(await ide.captureDiff(change.uri, change.originalUri, change.modifiedUri, label));
  if (attachments.reduce((bytes, item) => bytes + new TextEncoder().encode(item.text).byteLength, 0) > 2 * 1024 * 1024)
    throw new Error('This review exceeds 2 MiB. Select a smaller scope.');
  if (head !== history?.historyItemRef.get()?.revision || before !== signature())
    throw new Error('Git changed during capture. Start the review again.');
  // Check mutable index/worktree resources across the entire batch, not only each file.
  if (scope === Scope.STAGED || scope === Scope.ALL_LOCAL) {
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      const check = await ide.captureDiff(change.uri, change.originalUri, change.modifiedUri, label);
      if (check.contentRevision !== attachments[index].contentRevision)
        throw new Error('A changed file was edited during capture. Start the review again.');
    }
  }
  if (head !== history?.historyItemRef.get()?.revision || before !== signature())
    throw new Error('Git changed during capture. Start the review again.');
  return attachments;
}
