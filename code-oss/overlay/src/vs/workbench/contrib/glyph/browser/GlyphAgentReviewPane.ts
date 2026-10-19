import { ICommandService } from '#vs/platform/commands/common/commands.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { GlyphAgentReviewEditor, type GlyphAgentReviewFile } from './GlyphAgentReviewEditor.js';
import { AgentReviewStatus, type AgentReview } from '#vs/platform/glyph/reviewing/AgentReview.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { getIconClasses } from '#vs/editor/common/services/getIconClasses.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import { URI } from '#vs/base/common/uri.js';
import { DisposableMap, DisposableStore, MutableDisposable } from '#vs/base/common/lifecycle.js';
import { autorun } from '#vs/base/common/observable.js';
import { IConfigurationService, ConfigurationTarget } from '#vs/platform/configuration/common/configuration.js';
import { IContextKeyService } from '#vs/platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '#vs/platform/contextview/browser/contextView.js';
import { IHoverService } from '#vs/platform/hover/browser/hover.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '#vs/platform/keybinding/common/keybinding.js';
import { IOpenerService } from '#vs/platform/opener/common/opener.js';
import { IThemeService } from '#vs/platform/theme/common/themeService.js';
import { ViewPane } from '#vs/workbench/browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '#vs/workbench/browser/parts/views/viewsViewlet.js';
import { IViewDescriptorService } from '#vs/workbench/common/views.js';
import { ISCMService, ISCMRepository } from '#vs/workbench/contrib/scm/common/scm.js';
import { IQuickInputService } from '#vs/platform/quickinput/common/quickInput.js';
import { IViewsService } from '#vs/workbench/services/views/common/viewsService.js';
import { GlyphWorkbenchService } from '../common/GlyphWorkbenchService.js';
import {
  GlyphAgentReviewScope as Scope,
  GlyphAgentReviewControls,
  GlyphAgentReviewMount,
} from '#glyph/workbench/GlyphAgentReview.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import { mountGlyphAgentReview } from './ui/mountGlyphWorkbench.js';
import { captureGlyphAgentReview, glyphAgentReviewUnavailableReason } from './GlyphAgentReviewCapture.js';
import { useGlyphContext } from './GlyphNativeContextActions.js';

export class GlyphAgentReviewPane extends ViewPane {
  static readonly ID = 'workbench.view.glyphAgentReview';
  private readonly view = this._register(new MutableDisposable<ReturnType<GlyphAgentReviewMount>>());
  private readonly repositories = this._register(new DisposableMap<ISCMRepository, DisposableStore>());
  private readonly reviewEditor: GlyphAgentReviewEditor;
  private readonly reviewFiles = new Map<string, GlyphAgentReviewFile>();
  private displayedReviewId: string | undefined;
  private busy = false;
  private error: string | undefined;
  constructor(
    options: IViewletViewOptions,
    @IKeybindingService glyphKeybindings: IKeybindingService,
    @IContextMenuService contextMenuService: IContextMenuService,
    @IConfigurationService configurationService: IConfigurationService,
    @IContextKeyService glyphContextKeys: IContextKeyService,
    @IViewDescriptorService glyphViewDescriptors: IViewDescriptorService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IOpenerService openerService: IOpenerService,
    @IThemeService themeService: IThemeService,
    @IHoverService hoverService: IHoverService,
    @ISCMService private readonly scm: ISCMService,
    @IQuickInputService private readonly quick: IQuickInputService,
    @ICommandService private readonly commands: ICommandService,
    @IViewsService private readonly views: IViewsService,
    @GlyphWorkbenchService private readonly glyphService: GlyphWorkbenchService,
  ) {
    super(
      options,
      glyphKeybindings,
      contextMenuService,
      configurationService,
      glyphContextKeys,
      glyphViewDescriptors,
      instantiationService,
      openerService,
      themeService,
      hoverService,
    );

    this.reviewEditor = this._register(instantiationService.createInstance(GlyphAgentReviewEditor));
    this._register(glyphService.onDidChangeState(() => this.update()));
    this._register(
      configurationService.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('glyph.review')) this.refresh();
      }),
    );
    this._register(scm.onDidAddRepository(repository => this.watchRepository(repository)));
    this._register(
      scm.onDidRemoveRepository(repository => {
        this.repositories.deleteAndDispose(repository);
        this.refresh();
      }),
    );
    for (const repository of scm.repositories) this.watchRepository(repository);
  }
  protected override renderBody(container: HTMLElement): void {
    super.renderBody(container);
    this.view.value = mountGlyphAgentReview(container, this.controls());
  }
  private watchRepository(repository: ISCMRepository): void {
    if (repository.provider.providerId !== 'git') return;
    const store = new DisposableStore();
    this.repositories.set(repository, store);
    store.add(repository.provider.onDidChangeResources(() => this.refresh()));
    store.add(repository.provider.onDidChangeResourceGroups(() => this.refresh()));
    store.add(
      autorun(reader => {
        repository.provider.historyProvider.read(reader)?.historyItemRef.read(reader);
        this.refresh();
      }),
    );
  }
  private refresh(): void {
    this.error = undefined;
    this.update();
  }
  private get scope(): Scope {
    const value = this.configurationService.getValue<Scope>('glyph.review.scope');
    return Object.values(Scope).includes(value) ? value : Scope.LAST_COMMIT;
  }
  private get branch(): string {
    return this.configurationService.getValue<string>('glyph.review.baseBranch') || '';
  }
  private controls(): GlyphAgentReviewControls {
    const repositories = [...this.scm.repositories].filter(repository => repository.provider.providerId === 'git');
    const reasons = repositories.map(repository => glyphAgentReviewUnavailableReason(repository, this.scope));
    const unavailableReason = !repositories.length
      ? 'Open a Git repository to review changes.'
      : reasons.every(reason => reason !== undefined)
        ? reasons[0]
        : undefined;
    return {
      scope: this.scope,
      branch: this.branch,
      busy: this.busy,
      reviewing: this.reviewState?.status === AgentReviewStatus.RUNNING,
      completed: this.reviewState?.status === AgentReviewStatus.COMPLETED,
      resultScope: this.reviewState?.label,
      findings: this.visibleFindings,
      fileIconClasses: path =>
        this.instantiationService.invokeFunction(accessor =>
          getIconClasses(accessor.get(IModelService), accessor.get(ILanguageService), URI.file(path)),
        ),
      stop: () => {
        const review = this.reviewState;
        if (review) void this.perform(() => this.glyphService.cancelAgentReview(review.id));
      },
      fixAll: () => {
        void this.perform(() => this.fixFindings(this.visibleFindings.map(finding => finding.id)));
      },
      openFinding: id => {
        void this.perform(() => this.openFinding(id));
      },
      fixFinding: id => {
        void this.perform(() => this.fixFindings([id]));
      },
      dismissFinding: id => this.dismissFinding(id),
      error: this.error ?? this.reviewState?.error,
      unavailableReason,
      chooseScope: scope => {
        void this.perform(async () => {
          if (scope === Scope.BRANCH && !(await this.chooseBranch())) return;
          await this.configurationService.updateValue('glyph.review.scope', scope, ConfigurationTarget.USER);
        });
      },
      review: () => {
        void this.perform(() => this.review());
      },
    };
  }
  private update(): void {
    const review = this.reviewState;
    if (review && this.displayedReviewId !== review.id) {
      this.reviewEditor.clear();
      this.displayedReviewId = review.id;
      this.reviewFiles.clear();
      for (const file of review.files)
        this.reviewFiles.set(file.path, { uri: URI.parse(file.uri), before: file.before, after: file.after });
    }
    this.view.value?.update(this.controls());
  }
  private async perform(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.update();
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.update();
    }
  }
  private async repository(forReview = false): Promise<ISCMRepository | undefined> {
    const repositories = [...this.scm.repositories].filter(
      repository =>
        repository.provider.providerId === 'git' &&
        (!forReview || !glyphAgentReviewUnavailableReason(repository, this.scope)),
    );
    if (!repositories.length) throw new Error('Open a Git repository to review changes.');
    if (repositories.length === 1) return repositories[0];
    return (
      await this.quick.pick(
        repositories.map(repository => ({
          label: repository.provider.name,
          description: repository.provider.rootUri?.fsPath,
          repository,
        })),
        { title: 'Choose repository to review' },
      )
    )?.repository;
  }
  private async chooseBranch(repository?: ISCMRepository): Promise<string | undefined> {
    repository ??= await this.repository();
    if (!repository) return;
    const refs = await repository.provider.historyProvider.get()?.provideHistoryItemRefs();
    const branches = refs?.filter(ref => ref.id.startsWith('refs/heads/') || ref.id.startsWith('refs/remotes/'));
    if (!branches?.length) throw new Error('Git branch information is unavailable.');
    const selected = await this.quick.pick(
      branches.map(ref => ({ label: ref.name, description: ref.id, ref })),
      {
        title: 'Choose review base branch',
        placeHolder: 'Select a branch to compare against, type to filter',
        matchOnDescription: true,
      },
    );
    if (!selected) return;
    await this.configurationService.updateValue(
      'glyph.review.baseBranch',
      selected.ref.id,
      ConfigurationTarget.WORKSPACE,
    );
    return selected.ref.id;
  }
  private async review(): Promise<void> {
    const scope = this.scope;
    const repository = await this.repository(true);
    if (!repository) return;
    // Await Git's refresh before reading HEAD/index; filesystem watchers can lag a commit.
    await this.commands.executeCommand('git.refresh', repository.provider.rootUri);
    const branch = scope === Scope.BRANCH ? this.branch || (await this.chooseBranch(repository)) : '';
    if (branch === undefined) return;
    const files = new Map<string, GlyphAgentReviewFile>();
    const captured = await captureGlyphAgentReview(
      this.glyphService.ideContext,
      repository,
      scope,
      branch,
      (uri, before, after) => {
        const source = uri.with({ query: '', fragment: '' });
        files.set(source.toString(), { uri: source, before, after });
      },
    );
    const repositoryUri = repository.provider.rootUri;
    if (!repositoryUri) throw new Error('The repository root is unavailable.');
    await this.glyphService.startAgentReview({
      id: generateUuid(),
      repositoryUri: repositoryUri.toString(),
      scope,
      branch,
      label:
        scope === Scope.BRANCH
          ? `Compare against ${branch.replace(/^refs\/(heads|remotes)\//, '')}`
          : { lastCommit: 'Last commit', staged: 'Staged changes', allLocal: 'All local changes' }[scope],
      files: captured.map(attachment => {
        const file = files.get(attachment.uri);
        if (!file) throw new Error(`The captured comparison is unavailable for ${attachment.path}.`);
        return {
          path: attachment.path,
          uri: attachment.uri,
          before: file.before,
          after: file.after,
          contextText: attachment.text,
          revision: attachment.contentRevision,
        };
      }),
    });
  }
  private get reviewState(): AgentReview | undefined {
    return this.glyphService.state.agentReviews?.reduce<AgentReview | undefined>(
      (latest, review) => (!latest || review.createdAt > latest.createdAt ? review : latest),
      undefined,
    );
  }
  private get visibleFindings() {
    const review = this.reviewState;
    return review?.findings.filter(finding => !review.dismissedIds.includes(finding.id)) ?? [];
  }
  private async openFinding(id: string): Promise<void> {
    this.update();
    const finding = this.visibleFindings.find(finding => finding.id === id);
    const file = finding && this.reviewFiles.get(finding.path);
    if (!finding || !file) return;
    await this.reviewEditor.open(
      file,
      finding,
      this.visibleFindings,
      issue => {
        void this.perform(() => this.fixFindings([issue.id]));
      },
      issue => this.dismissFinding(issue.id),
    );
  }
  private async fixFindings(ids: readonly string[]): Promise<void> {
    const review = this.reviewState;
    if (!review) return;
    const findings = this.visibleFindings.filter(finding => ids.includes(finding.id));
    if (!findings.length) return;
    const paths = new Set(findings.map(finding => finding.path));
    const attachments: GlyphContextAttachment[] = review.files
      .filter(file => paths.has(file.path))
      .map(file => ({
        kind: GlyphContextAttachmentKind.DIFF,
        uri: file.uri,
        path: file.path,
        text: file.contextText,
        contentRevision: file.revision,
      }));
    await useGlyphContext(
      this.glyphService,
      this.views,
      async () => attachments,
      `${findings.length === 1 ? 'Fix this agent review issue' : 'Fix all of these agent review issues'}.\n\n${findings.map(finding => `${finding.path}:${finding.line} — ${finding.title}\n${finding.body}`).join('\n\n')}\n\nCheck each issue against the current source before changing files; the attached revisions are the reviewed snapshots.`,
      AgentModeID.AGENT,
    );
  }
  private dismissFinding(id: string): void {
    const review = this.reviewState;
    if (!review) return;
    void this.perform(async () => {
      await this.glyphService.dismissAgentReviewFinding(review.id, id);
      this.reviewEditor.dismiss(id);
    });
  }
}
