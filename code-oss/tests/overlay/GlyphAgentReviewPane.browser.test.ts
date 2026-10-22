import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Emitter } from '#vs/base/common/event.js';
import { URI } from '#vs/base/common/uri.js';
import { observableValue } from '#vs/base/common/observable.js';
import { ConfigurationTarget } from '#vs/platform/configuration/common/configuration.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import type { ISCMRepository } from '#vs/workbench/contrib/scm/common/scm.js';
import { AgentReviewStatus, type AgentReview } from '#vs/platform/glyph/reviewing/AgentReview.js';
import { GlyphAgentReviewScope as Scope, type GlyphAgentReviewControls } from '#glyph/workbench/GlyphAgentReview.js';
import { GlyphContextAttachmentKind } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import { GlyphAgentReviewEditor } from '#vs/workbench/contrib/glyph/browser/GlyphAgentReviewEditor.js';
import { useGlyphContext } from '#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js';
import { GlyphAgentReviewPane } from '#vs/workbench/contrib/glyph/browser/GlyphAgentReviewPane.js';

const mounts = vi.hoisted(() => ({ mountGlyphAgentReview: vi.fn(), mountGlyphAgentReviewComment: vi.fn() }));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);
vi.mock('#vs/workbench/browser/parts/views/viewPane.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  ViewPane: (await import('./support/ViewPaneStub.ts')).ViewPaneStub,
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js', () => ({
  useGlyphContext: vi.fn(async (_glyph: unknown, _views: unknown, capture: () => Promise<unknown>) => {
    await capture();
  }),
}));

interface FakeRef {
  id: string;
  name: string;
  revision?: string;
}

const repositoryOf = (
  options: {
    providerId?: string;
    name?: string;
    rootUri?: URI | null;
    revision?: string;
    refs?: FakeRef[];
    groups?: { id: string; resources: { sourceUri: URI; multiDiffEditorModifiedUri?: URI }[] }[];
  } = {},
) => {
  const resourcesChanged = new Emitter<void>();
  const groupsChanged = new Emitter<void>();
  const historyItemRef = observableValue<{ revision: string } | undefined>(
    'historyItemRef',
    options.revision === undefined
      ? { revision: 'head' }
      : options.revision
        ? { revision: options.revision }
        : undefined,
  );
  const history = {
    historyItemRef,
    resolveHistoryItem: vi.fn(async () => ({ parentIds: ['parent'] })),
    provideHistoryItemChanges: vi.fn(async () => [
      { uri: URI.file('/repo/src/a.ts'), modifiedUri: URI.file('/repo/src/a.ts') },
    ]),
    provideHistoryItemRefs: vi.fn(async (ids?: string[]) =>
      (
        options.refs ?? [
          { id: 'refs/heads/main', name: 'main', revision: 'main-tip' },
          { id: 'refs/remotes/origin/dev', name: 'origin/dev', revision: 'dev-tip' },
          { id: 'refs/tags/v1', name: 'v1', revision: 'tag' },
        ]
      ).filter(ref => !ids || ids.includes(ref.id)),
    ),
    resolveHistoryItemRefsCommonAncestor: vi.fn(async () => 'ancestor'),
  };
  const historyProvider = observableValue<typeof history | undefined>('historyProvider', history);
  const repository = {
    provider: {
      providerId: options.providerId ?? 'git',
      name: options.name ?? 'repo',
      rootUri: options.rootUri === null ? undefined : (options.rootUri ?? URI.file('/repo')),
      groups: options.groups ?? [],
      historyProvider,
      onDidChangeResources: resourcesChanged.event,
      onDidChangeResourceGroups: groupsChanged.event,
    },
  };
  return {
    repository: repository as unknown as ISCMRepository,
    history,
    historyProvider,
    historyItemRef,
    resourcesChanged,
    groupsChanged,
  };
};

const reviewOf = (overrides: Partial<AgentReview> = {}): AgentReview => ({
  id: 'review-1',
  repositoryUri: 'file:///repo',
  scope: Scope.LAST_COMMIT,
  branch: '',
  label: 'Last commit',
  files: [
    {
      path: 'src/a.ts',
      uri: 'file:///repo/src/a.ts',
      before: 'old a',
      after: 'new a',
      contextText: 'diff a',
      revision: 'rev-a',
    },
    {
      path: 'src/gone.ts',
      uri: 'file:///repo/src/gone.ts',
      before: 'old gone',
      after: '',
      contextText: 'diff gone',
      revision: 'rev-gone',
    },
  ],
  accountProvider: 'openai',
  accountId: 'account-1',
  model: 'gpt',
  status: AgentReviewStatus.COMPLETED,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  findings: [
    { id: 'finding-1', path: 'src/a.ts', line: 3, title: 'Bug', body: 'Explain a' },
    { id: 'finding-2', path: 'src/gone.ts', line: 1, title: 'Lost', body: 'Explain gone' },
    { id: 'finding-3', path: 'src/a.ts', line: 9, side: 'original', title: 'Old', body: 'Explain old' },
  ],
  dismissedIds: [],
  summary: '',
  ...overrides,
});

const paneOf = (
  repositories: ISCMRepository[] = [repositoryOf().repository],
  settings: Record<string, unknown> = {},
) => {
  const config = new Map<string, unknown>(Object.entries(settings));
  const configChanged = new Emitter<{ affectsConfiguration(key: string): boolean }>();
  const added = new Emitter<ISCMRepository>();
  const removed = new Emitter<ISCMRepository>();
  const stateChanged = new Emitter<void>();
  const reviewEditor = { open: vi.fn(async () => {}), clear: vi.fn(), dismiss: vi.fn(), dispose: vi.fn() };
  const services = {
    configuration: {
      getValue: vi.fn((key: string) => config.get(key)),
      updateValue: vi.fn(async (key: string, value: unknown, _target: ConfigurationTarget) => {
        config.set(key, value);
      }),
      onDidChangeConfiguration: configChanged.event,
    },
    instantiation: {
      createInstance: vi.fn(() => reviewEditor),
      invokeFunction: vi.fn(<T>(fn: (accessor: { get(id: unknown): unknown }) => T) =>
        fn({
          get: id =>
            id === IModelService
              ? { getModel: () => null }
              : id === ILanguageService
                ? { guessLanguageIdByFilepathOrFirstLine: () => 'typescript' }
                : undefined,
        }),
      ),
    },
    scm: { repositories, onDidAddRepository: added.event, onDidRemoveRepository: removed.event },
    quick: { pick: vi.fn(async (_items: unknown[], _options: unknown): Promise<unknown> => undefined) },
    commands: { executeCommand: vi.fn(async () => undefined) },
    views: { id: 'views' },
    glyph: {
      state: { agentReviews: undefined } as { agentReviews?: AgentReview[] },
      onDidChangeState: stateChanged.event,
      ideContext: {
        captureDiff: vi.fn(
          async (uri: URI, _before: URI, _after: URI, label: string, captured?: (b: string, a: string) => void) => {
            captured?.('captured before', 'captured after');
            return {
              kind: GlyphContextAttachmentKind.DIFF,
              uri: uri.toString(),
              path: 'src/a.ts',
              text: label,
              contentRevision: 'rev-captured',
            };
          },
        ),
      },
      startAgentReview: vi.fn(async () => {}),
      cancelAgentReview: vi.fn(async () => {}),
      dismissAgentReviewFinding: vi.fn(async () => {}),
    },
  };
  const pane = new GlyphAgentReviewPane(
    { id: GlyphAgentReviewPane.ID, title: 'Agent Review' },
    {} as never,
    {} as never,
    services.configuration as never,
    {} as never,
    {} as never,
    services.instantiation as never,
    {} as never,
    {} as never,
    {} as never,
    services.scm as never,
    services.quick as never,
    services.commands as never,
    services.views as never,
    services.glyph as never,
  );
  const view = { update: vi.fn(), dispose: vi.fn() };
  mounts.mountGlyphAgentReview.mockReturnValueOnce(view);
  (pane as unknown as { renderBody(container: HTMLElement): void }).renderBody(document.createElement('div'));
  const mounted = mounts.mountGlyphAgentReview.mock.lastCall![1] as GlyphAgentReviewControls;
  onTestFinished(() => {
    pane.dispose();
    mounts.mountGlyphAgentReview.mockReset();
    vi.mocked(useGlyphContext).mockClear();
  });
  const controls = (): GlyphAgentReviewControls =>
    (view.update.mock.lastCall?.[0] as GlyphAgentReviewControls | undefined) ?? mounted;
  return {
    pane,
    view,
    services,
    reviewEditor,
    controls,
    publish(reviews: AgentReview[] | undefined) {
      services.glyph.state = { agentReviews: reviews };
      stateChanged.fire();
    },
    changeConfiguration(key: string) {
      configChanged.fire({ affectsConfiguration: affected => key.startsWith(affected) });
    },
    added,
    removed,
    settled: () =>
      vi.waitFor(() => {
        expect(controls().busy).toBe(false);
      }),
  };
};

describe(GlyphAgentReviewPane, () => {
  it('mounts the review controls for the configured scope and branch', () => {
    const { services, controls } = paneOf([repositoryOf().repository], {
      'glyph.review.scope': Scope.STAGED,
      'glyph.review.baseBranch': 'refs/heads/main',
    });

    expect(services.instantiation.createInstance).toHaveBeenCalledWith(GlyphAgentReviewEditor);
    expect(controls()).toEqual(
      expect.objectContaining({
        scope: Scope.STAGED,
        branch: 'refs/heads/main',
        busy: false,
        reviewing: false,
        completed: false,
        resultScope: undefined,
        findings: [],
        error: undefined,
        unavailableReason: 'There are no changes in the selected review scope.',
      }),
    );
  });

  it('falls back to reviewing the last commit for unknown scopes', () => {
    const { controls } = paneOf([repositoryOf().repository], { 'glyph.review.scope': 'everything' });

    expect(controls().scope).toBe(Scope.LAST_COMMIT);
    expect(controls().branch).toBe('');
    expect(controls().unavailableReason).toBeUndefined();
  });

  it('asks for a Git repository when none is open', () => {
    const { controls } = paneOf([repositoryOf({ providerId: 'hg' }).repository]);

    expect(controls().unavailableReason).toBe('Open a Git repository to review changes.');
  });

  it('is available while any repository can be reviewed', () => {
    const mixed = paneOf([repositoryOf({ revision: '' }).repository, repositoryOf().repository]);
    const blocked = paneOf([repositoryOf({ revision: '' }).repository, repositoryOf({ revision: '' }).repository]);

    expect(mixed.controls().unavailableReason).toBeUndefined();
    expect(blocked.controls().unavailableReason).toBe('Git history is unavailable. Create a commit to review.');
  });

  it('refreshes when Git, repositories, or review settings change', () => {
    const watched = repositoryOf();
    const ignored = repositoryOf({ providerId: 'hg' });
    const { view, added, removed, changeConfiguration } = paneOf([watched.repository, ignored.repository]);
    const later = repositoryOf();
    const updates = () => view.update.mock.calls.length;

    const initial = updates();
    watched.resourcesChanged.fire();
    watched.groupsChanged.fire();
    watched.historyItemRef.set({ revision: 'moved' }, undefined);
    watched.historyProvider.set(undefined, undefined);
    ignored.resourcesChanged.fire();
    expect(updates()).toBe(initial + 4);

    added.fire(later.repository);
    added.fire(repositoryOf({ providerId: 'hg' }).repository);
    later.groupsChanged.fire();
    expect(updates()).toBe(initial + 6);

    removed.fire(later.repository);
    later.groupsChanged.fire();
    changeConfiguration('glyph.review.scope');
    changeConfiguration('editor.fontSize');
    expect(updates()).toBe(initial + 8);
  });

  it('shows the latest review and its remaining findings', () => {
    const { controls, publish, reviewEditor } = paneOf();

    publish([
      reviewOf({ id: 'review-old', createdAt: '2025-01-01T00:00:00.000Z' }),
      reviewOf({
        id: 'review-new',
        label: 'Staged changes',
        status: AgentReviewStatus.RUNNING,
        createdAt: '2026-06-01T00:00:00.000Z',
        dismissedIds: ['finding-2'],
      }),
      reviewOf({ id: 'review-older', createdAt: '2024-01-01T00:00:00.000Z' }),
    ]);

    expect(controls()).toEqual(
      expect.objectContaining({
        reviewing: true,
        completed: false,
        resultScope: 'Staged changes',
        findings: [expect.objectContaining({ id: 'finding-1' }), expect.objectContaining({ id: 'finding-3' })],
      }),
    );
    expect(reviewEditor.clear).toHaveBeenCalledTimes(1);

    publish([reviewOf({ id: 'review-new', createdAt: '2026-06-01T00:00:00.000Z', error: 'Provider failed' })]);
    expect(controls()).toEqual(expect.objectContaining({ completed: true, error: 'Provider failed' }));
    expect(reviewEditor.clear).toHaveBeenCalledTimes(1);
  });

  it('resolves file icons through the workbench language service', () => {
    const { controls } = paneOf();

    expect(controls().fileIconClasses!('/repo/src/a.ts')).toEqual(
      expect.arrayContaining(['file-icon', 'a.ts-name-file-icon', 'typescript-lang-file-icon']),
    );
  });

  it('stops the current review', async () => {
    const { controls, publish, services, settled } = paneOf();
    controls().stop!();
    expect(controls().busy).toBe(false);
    publish([reviewOf()]);

    controls().stop!();
    await settled();

    expect(services.glyph.cancelAgentReview).toHaveBeenCalledWith('review-1');
    expect(services.glyph.cancelAgentReview).toHaveBeenCalledTimes(1);
  });

  it('remembers the chosen scope for the user', async () => {
    const { controls, services, settled } = paneOf();

    controls().chooseScope(Scope.STAGED);
    await settled();

    expect(services.configuration.updateValue).toHaveBeenCalledWith(
      'glyph.review.scope',
      Scope.STAGED,
      ConfigurationTarget.USER,
    );
    expect(services.quick.pick).not.toHaveBeenCalled();
  });

  it('asks for the base branch before comparing against a branch', async () => {
    const { controls, services, settled } = paneOf();
    services.quick.pick.mockImplementationOnce(async items => items[1]);

    controls().chooseScope(Scope.BRANCH);
    await settled();

    expect(services.quick.pick).toHaveBeenCalledWith(
      [
        { label: 'main', description: 'refs/heads/main', ref: expect.objectContaining({ id: 'refs/heads/main' }) },
        {
          label: 'origin/dev',
          description: 'refs/remotes/origin/dev',
          ref: expect.objectContaining({ id: 'refs/remotes/origin/dev' }),
        },
      ],
      {
        title: 'Choose review base branch',
        placeHolder: 'Select a branch to compare against, type to filter',
        matchOnDescription: true,
      },
    );
    expect(services.configuration.updateValue.mock.calls).toEqual([
      ['glyph.review.baseBranch', 'refs/remotes/origin/dev', ConfigurationTarget.WORKSPACE],
      ['glyph.review.scope', Scope.BRANCH, ConfigurationTarget.USER],
    ]);
  });

  it('keeps the scope when no base branch is chosen', async () => {
    const { controls, services, settled } = paneOf();

    controls().chooseScope(Scope.BRANCH);
    await settled();

    expect(services.quick.pick).toHaveBeenCalled();
    expect(services.configuration.updateValue).not.toHaveBeenCalled();
  });

  it('reports repositories without branch information', async () => {
    const withoutBranches = repositoryOf({ refs: [{ id: 'refs/tags/v1', name: 'v1' }] });
    const withoutHistory = repositoryOf();
    withoutHistory.historyProvider.set(undefined, undefined);
    for (const { repository } of [withoutBranches, withoutHistory]) {
      const { controls, services, settled } = paneOf([repository]);

      controls().chooseScope(Scope.BRANCH);
      await settled();

      expect(controls().error).toBe('Git branch information is unavailable.');
      expect(services.configuration.updateValue).not.toHaveBeenCalled();
    }
  });

  it('asks which repository to use when several are open', async () => {
    const first = repositoryOf({ name: 'first', rootUri: URI.file('/first') });
    const second = repositoryOf({ name: 'second', rootUri: null });
    const { controls, services, settled } = paneOf([first.repository, second.repository]);
    services.quick.pick.mockImplementationOnce(async items => items[1]);

    controls().chooseScope(Scope.BRANCH);
    await settled();
    controls().chooseScope(Scope.BRANCH);
    await settled();

    expect(services.quick.pick.mock.calls[0]).toEqual([
      [
        { label: 'first', description: URI.file('/first').fsPath, repository: first.repository },
        { label: 'second', description: undefined, repository: second.repository },
      ],
      { title: 'Choose repository to review' },
    ]);
    expect(second.history.provideHistoryItemRefs).toHaveBeenCalledTimes(1);
    expect(first.history.provideHistoryItemRefs).not.toHaveBeenCalled();
    expect(services.quick.pick).toHaveBeenCalledTimes(3);
  });

  it('starts a review of the captured comparison', async () => {
    const { controls, services, settled } = paneOf();

    controls().review();
    await settled();

    const [command, root] = services.commands.executeCommand.mock.calls[0] as unknown as [string, URI];
    expect(command).toBe('git.refresh');
    expect(root.toString()).toBe(URI.file('/repo').toString());
    expect(services.glyph.startAgentReview).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      repositoryUri: URI.file('/repo').toString(),
      scope: Scope.LAST_COMMIT,
      branch: '',
      label: 'Last commit',
      files: [
        {
          path: 'src/a.ts',
          uri: URI.file('/repo/src/a.ts').toString(),
          before: 'captured before',
          after: 'captured after',
          contextText: 'Last commit: parent → head',
          revision: 'rev-captured',
        },
      ],
    });
    expect(controls().error).toBeUndefined();
  });

  it('labels reviews of local changes', async () => {
    for (const [scope, label] of [
      [Scope.STAGED, 'Staged changes'],
      [Scope.ALL_LOCAL, 'All local changes'],
    ] as const) {
      const repository = repositoryOf({
        groups: [
          {
            id: 'index',
            resources: [
              { sourceUri: URI.file('/repo/src/a.ts'), multiDiffEditorModifiedUri: URI.file('/repo/src/a.ts') },
            ],
          },
        ],
      });
      const { controls, services, settled } = paneOf([repository.repository], { 'glyph.review.scope': scope });

      controls().review();
      await settled();

      expect(services.glyph.startAgentReview).toHaveBeenCalledWith(expect.objectContaining({ scope, label }));
    }
  });

  it('compares against the configured base branch', async () => {
    const { controls, services, settled } = paneOf([repositoryOf().repository], {
      'glyph.review.scope': Scope.BRANCH,
      'glyph.review.baseBranch': 'refs/remotes/origin/dev',
    });

    controls().review();
    await settled();

    expect(services.quick.pick).not.toHaveBeenCalled();
    expect(services.glyph.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'refs/remotes/origin/dev', label: 'Compare against origin/dev' }),
    );
  });

  it('asks for a base branch when reviewing without one', async () => {
    const chosen = paneOf([repositoryOf().repository], { 'glyph.review.scope': Scope.BRANCH });
    const cancelled = paneOf([repositoryOf().repository], { 'glyph.review.scope': Scope.BRANCH });
    chosen.services.quick.pick.mockImplementationOnce(async items => items[0]);

    chosen.controls().review();
    cancelled.controls().review();
    await chosen.settled();
    await cancelled.settled();

    expect(chosen.services.glyph.startAgentReview).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'refs/heads/main', label: 'Compare against main' }),
    );
    expect(cancelled.services.quick.pick).toHaveBeenCalled();
    expect(cancelled.services.glyph.startAgentReview).not.toHaveBeenCalled();
  });

  it('reviews only repositories that can be reviewed', async () => {
    const blocked = repositoryOf({ revision: '' });
    const ready = repositoryOf({ name: 'ready' });
    const { controls, services, settled } = paneOf([blocked.repository, ready.repository]);

    controls().review();
    await settled();

    expect(services.quick.pick).not.toHaveBeenCalled();
    expect(ready.history.provideHistoryItemChanges).toHaveBeenCalled();
  });

  it('does nothing when the repository choice is dismissed', async () => {
    const { controls, services, settled } = paneOf([repositoryOf().repository, repositoryOf().repository]);

    controls().review();
    await settled();

    expect(services.commands.executeCommand).not.toHaveBeenCalled();
    expect(services.glyph.startAgentReview).not.toHaveBeenCalled();
  });

  it('reports reviews that cannot start', async () => {
    const cases = [
      {
        repositories: [repositoryOf({ providerId: 'hg' }).repository],
        error: 'Open a Git repository to review changes.',
      },
      { repositories: [repositoryOf({ rootUri: null }).repository], error: 'The repository root is unavailable.' },
    ];
    for (const { repositories, error } of cases) {
      const { controls, services, settled } = paneOf(repositories);

      controls().review();
      await settled();

      expect(controls().error).toBe(error);
      expect(services.glyph.startAgentReview).not.toHaveBeenCalled();
    }
  });

  it('reports captures without a comparison', async () => {
    const { controls, services, settled } = paneOf();
    services.glyph.ideContext.captureDiff.mockImplementationOnce(async (uri: URI) => ({
      kind: GlyphContextAttachmentKind.DIFF,
      uri: uri.toString(),
      path: 'src/a.ts',
      text: '',
      contentRevision: 'r',
    }));

    controls().review();
    await settled();

    expect(controls().error).toBe('The captured comparison is unavailable for src/a.ts.');
  });

  it('reports failures that are not errors', async () => {
    const { controls, services, settled } = paneOf();
    services.glyph.startAgentReview.mockRejectedValueOnce('offline');

    controls().review();
    await settled();

    expect(controls().error).toBe('offline');
  });

  it('clears a reported failure when the review settings change', async () => {
    const { controls, services, settled, changeConfiguration } = paneOf();
    services.glyph.startAgentReview.mockRejectedValueOnce(new Error('offline'));
    controls().review();
    await settled();

    changeConfiguration('glyph.review.baseBranch');

    expect(controls().error).toBeUndefined();
  });

  it('ignores actions while another is running', async () => {
    const { controls, services, settled } = paneOf();

    controls().review();
    controls().review();
    expect(controls().busy).toBe(true);
    await settled();

    expect(services.glyph.startAgentReview).toHaveBeenCalledTimes(1);
  });

  it('opens a finding in the reviewed revisions', async () => {
    const { controls, publish, reviewEditor, services, settled } = paneOf();
    publish([reviewOf({ dismissedIds: ['finding-2'] })]);

    controls().openFinding!('finding-1');
    await settled();

    expect(reviewEditor.open).toHaveBeenCalledWith(
      { uri: URI.parse('file:///repo/src/a.ts'), before: 'old a', after: 'new a' },
      expect.objectContaining({ id: 'finding-1' }),
      [expect.objectContaining({ id: 'finding-1' }), expect.objectContaining({ id: 'finding-3' })],
      expect.any(Function),
      expect.any(Function),
    );
    const [, , , fix, dismiss] = reviewEditor.open.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      (finding: { id: string }) => void,
      (finding: { id: string }) => void,
    ];
    fix({ id: 'finding-3' });
    await settled();
    expect(useGlyphContext).toHaveBeenCalledWith(
      services.glyph,
      services.views,
      expect.any(Function),
      expect.stringContaining('src/a.ts:9 (original) — Old'),
      AgentModeID.AGENT,
    );
    dismiss({ id: 'finding-3' });
    await settled();
    expect(services.glyph.dismissAgentReviewFinding).toHaveBeenCalledWith('review-1', 'finding-3');
    expect(reviewEditor.dismiss).toHaveBeenCalledWith('finding-3');
  });

  it('opens nothing for findings that are unknown or outside the reviewed files', async () => {
    const { controls, publish, reviewEditor, settled } = paneOf();
    publish([
      reviewOf({
        dismissedIds: ['finding-1'],
        findings: [
          { id: 'finding-1', path: 'src/a.ts', line: 1, title: 'A', body: 'A' },
          { id: 'finding-4', path: 'src/missing.ts', line: 1, title: 'B', body: 'B' },
        ],
      }),
    ]);

    controls().openFinding!('finding-1');
    await settled();
    controls().openFinding!('finding-4');
    await settled();

    expect(reviewEditor.open).not.toHaveBeenCalled();
  });

  it('asks the agent to fix one finding with its reviewed revision attached', async () => {
    const { controls, publish, services, settled } = paneOf();
    publish([reviewOf()]);

    controls().fixFinding!('finding-2');
    await settled();

    const [, , capture, prompt] = vi.mocked(useGlyphContext).mock.calls[0];
    await expect(capture()).resolves.toEqual([
      {
        kind: GlyphContextAttachmentKind.DIFF,
        uri: 'file:///repo/src/gone.ts',
        path: 'src/gone.ts',
        text: 'diff gone',
        contentRevision: 'rev-gone',
      },
    ]);
    expect(prompt).toBe(
      'Fix this agent review issue.\n\nsrc/gone.ts:1 (original) — Lost\nExplain gone\n\nCheck each issue against the current source before changing files; the attached revisions are the reviewed snapshots.',
    );
    expect(services.glyph.startAgentReview).not.toHaveBeenCalled();
  });

  it('asks the agent to fix every remaining finding', async () => {
    const { controls, publish, settled } = paneOf();
    publish([
      reviewOf({
        dismissedIds: ['finding-2'],
        findings: [
          ...reviewOf().findings,
          { id: 'finding-4', path: 'src/missing.ts', line: 2, title: 'Gone', body: 'Explain missing' },
        ],
      }),
    ]);

    controls().fixAll!();
    await settled();

    const [, , capture, prompt] = vi.mocked(useGlyphContext).mock.calls[0];
    await expect(capture()).resolves.toEqual([expect.objectContaining({ path: 'src/a.ts' })]);
    expect(prompt).toBe(
      'Fix all of these agent review issues.\n\nsrc/a.ts:3 (modified) — Bug\nExplain a\n\nsrc/a.ts:9 (original) — Old\nExplain old\n\nsrc/missing.ts:2 (original) — Gone\nExplain missing\n\nCheck each issue against the current source before changing files; the attached revisions are the reviewed snapshots.',
    );
  });

  it('fixes nothing without a review or a matching finding', async () => {
    const { controls, publish, settled } = paneOf();

    controls().fixAll!();
    await settled();
    publish([reviewOf()]);
    controls().fixFinding!('unknown');
    await settled();

    expect(useGlyphContext).not.toHaveBeenCalled();
  });

  it('dismisses findings of the current review', async () => {
    const { controls, publish, services, reviewEditor, settled } = paneOf();
    controls().dismissFinding!('finding-1');
    expect(controls().busy).toBe(false);
    publish([reviewOf()]);

    controls().dismissFinding!('finding-1');
    await settled();

    expect(services.glyph.dismissAgentReviewFinding).toHaveBeenCalledTimes(1);
    expect(services.glyph.dismissAgentReviewFinding).toHaveBeenCalledWith('review-1', 'finding-1');
    expect(reviewEditor.dismiss).toHaveBeenCalledWith('finding-1');
  });
});
