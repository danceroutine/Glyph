import { generateUuid } from '#vs/base/common/uuid.js';
import { GlyphAgentReviewEditor, type GlyphAgentReviewFile } from './GlyphAgentReviewEditor.js';
import {
  parseGlyphAgentReviewFindings,
  type GlyphAgentReviewFinding,
} from '#glyph/workbench/GlyphAgentReviewFinding.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { GlyphRunStatus } from '#glyph/protocol/events/GlyphRunProjection.js';
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
  private captured: readonly GlyphContextAttachment[] = [];
  private findings: readonly GlyphAgentReviewFinding[] = [];
  private readonly dismissed = new Set<string>();
  private reviewRun: { chatId: string; runId: string } | undefined;
  private reviewPrompt: string | undefined;
  private reviewId: string | undefined;
  private reviewing = false;
  private completed = false;
  private resultScope = '';
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
    this._register(glyphService.onDidChangeState(() => this.observeReview()));
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
      reviewing: this.reviewing,
      completed: this.completed,
      resultScope: this.resultScope,
      findings: this.findings.filter(finding => !this.dismissed.has(finding.id)),
      fileIconClasses: path =>
        this.instantiationService.invokeFunction(accessor =>
          getIconClasses(accessor.get(IModelService), accessor.get(ILanguageService), URI.file(path)),
        ),
      stop: () => {
        if (this.reviewRun)
          void this.glyphService.cancelRun(this.reviewRun.chatId, this.reviewRun.runId).catch(error => {
            this.error = String(error);
            this.update();
          });
      },
      openFinding: id => {
        void this.perform(() => this.openFinding(id));
      },
      fixFinding: id => {
        void this.perform(() => this.fixFinding(id));
      },
      dismissFinding: id => this.dismissFinding(id),
      error: this.error,
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
    const branch = scope === Scope.BRANCH ? this.branch || (await this.chooseBranch(repository)) : '';
    if (branch === undefined) return;
    this.reviewFiles.clear();
    this.captured = await captureGlyphAgentReview(
      this.glyphService.ideContext,
      repository,
      scope,
      branch,
      (uri, before, after) => {
        const source = uri.with({ query: '', fragment: '' });
        this.reviewFiles.set(source.toString(), { uri: source, before, after });
      },
    );
    const capturedFiles = new Map<string, GlyphAgentReviewFile>();
    for (const attachment of this.captured) {
      const file = this.reviewFiles.get(attachment.uri);
      if (file) capturedFiles.set(attachment.path, file);
    }
    this.reviewFiles.clear();
    for (const [path, file] of capturedFiles) this.reviewFiles.set(path, file);
    this.findings = [];
    this.dismissed.clear();
    this.completed = false;
    this.resultScope =
      scope === Scope.BRANCH
        ? `Compare against ${branch.replace(/^refs\/(heads|remotes)\//, '')}`
        : { lastCommit: 'Last commit', staged: 'Staged changes', allLocal: 'All local changes' }[scope];
    this.reviewId = generateUuid();
    this.reviewRun = undefined;
    this.reviewPrompt =
      'Review the attached Git comparison for actionable bugs and regressions. Do not modify files. Use the captured revisions.';
    this.reviewing = true;
    this.update();
    try {
      await useGlyphContext(
        this.glyphService,
        this.views,
        async () => this.captured,
        this.reviewPrompt,
        AgentModeID.PLAN,
        { agentReviewId: this.reviewId },
      );
      this.observeReview();
    } catch (error) {
      this.reviewing = false;
      this.reviewPrompt = undefined;
      throw error;
    }
  }
  private observeReview(): void {
    if (!this.reviewPrompt || !this.reviewing) return;
    const run = this.reviewRun
      ? this.glyphService.state.runs.find(
          run => run.runId === this.reviewRun!.runId && run.chatId === this.reviewRun!.chatId,
        )
      : this.glyphService.state.runs.find(run => run.options?.agentReviewId === this.reviewId);
    if (!run) return;
    this.reviewRun = { chatId: run.chatId, runId: run.runId };
    const result = parseGlyphAgentReviewFindings(
      run.text,
      new Map(
        [...this.reviewFiles].map(([path, file]) => [
          path,
          Math.max(1, (file.after || file.before).split('\n').length),
        ]),
      ),
    );
    this.findings = result.findings;
    if (
      [GlyphRunStatus.COMPLETED, GlyphRunStatus.CANCELLED, GlyphRunStatus.FAILED, GlyphRunStatus.INTERRUPTED].includes(
        run.status,
      )
    ) {
      this.reviewing = false;
      this.completed = run.status === GlyphRunStatus.COMPLETED && result.complete;
      if (run.status === GlyphRunStatus.COMPLETED && !result.complete)
        this.error =
          'The review did not return a complete findings report. You can inspect its response in chat or run it again.';
      else if (run.status === GlyphRunStatus.FAILED || run.status === GlyphRunStatus.INTERRUPTED)
        this.error = run.terminalMessage ?? 'Review interrupted. Run it again to finish.';
    }
    this.update();
  }
  private async openFinding(id: string): Promise<void> {
    const finding = this.findings.find(finding => finding.id === id);
    const file = finding && this.reviewFiles.get(finding.path);
    if (!finding || !file) return;
    await this.reviewEditor.open(
      file,
      finding,
      this.findings.filter(finding => !this.dismissed.has(finding.id)),
      issue => {
        void this.perform(() => this.fixFinding(issue.id));
      },
      issue => this.dismissFinding(issue.id),
    );
  }
  private async fixFinding(id: string): Promise<void> {
    const finding = this.findings.find(finding => finding.id === id);
    if (!finding) return;
    const attachment = this.captured.find(attachment => attachment.path === finding.path);
    if (!attachment) return;
    await useGlyphContext(
      this.glyphService,
      this.views,
      async () => [attachment],
      `Fix this agent review issue in ${finding.path}:${finding.line}.\n\n${finding.title}\n\n${finding.body}\n\nCheck that it still applies to the current source before changing files.`,
      AgentModeID.AGENT,
    );
  }
  private dismissFinding(id: string): void {
    this.dismissed.add(id);
    this.reviewEditor.dismiss(id);
    this.update();
  }
}
