import type { AgentReviewInput } from '#vs/platform/glyph/reviewing/AgentReview.js';
import { GlyphShellTerminals } from './GlyphShellTerminals.js';
import { BrowserViewUri } from '#vs/platform/browserView/common/browserViewUri.js';
import type { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import { GlyphFollowUpBehavior } from '#glyph/workbench/GlyphFollowUpBehavior.js';
import { IClipboardService } from '#vs/platform/clipboard/common/clipboardService.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import { IConfigurationService } from '#vs/platform/configuration/common/configuration.js';
import { toGlyphTranscriptParts } from '#glyph/workbench/toGlyphTranscriptParts.js';
import type { GlyphPlan } from '#glyph/protocol/events/GlyphPlan.js';
import { GlyphPlanInput } from './GlyphPlanEditor.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { IOpenerService } from '#vs/platform/opener/common/opener.js';
import { URI } from '#vs/base/common/uri.js';
import type { GlyphTurnOptions } from '#glyph/protocol/events/GlyphAnnotation.js';
import { GlyphContextController } from './GlyphContextController.js';
import { GlyphContextError } from './GlyphContextError.js';
import { GlyphProposalReviewError } from './GlyphProposalReviewError.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import type { GlyphApprovalDecision } from '#glyph/protocol/GlyphApprovalDecision.js';
import { IStorageService, StorageScope, StorageTarget } from '#vs/platform/storage/common/storage.js';
import type { GlyphModelSummary } from '#glyph/protocol/events/GlyphModelSummary.js';
import { Emitter } from '#vs/base/common/event.js';
import { GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '#vs/platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '#vs/platform/workspace/common/workspaceTrust.js';
import { IUserDataProfileService } from '#vs/workbench/services/userDataProfile/common/userDataProfile.js';
import { GlyphWorkbenchProjection } from '#glyph/workbench/GlyphWorkbenchProjection.js';
import { GlyphHostEventType } from '#glyph/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#glyph/protocol/events/GlyphRunProjection.js';
import { GlyphHostStatus } from '#glyph/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType, type GlyphWorkbenchCommand } from '#glyph/protocol/GlyphWorkbenchCommand.js';
import { type GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { GlyphDesktopClient } from '#vs/workbench/contrib/glyph/electron-browser/GlyphDesktopClient.js';
import { GlyphProposalEditor } from './GlyphProposalEditor.js';
import { GlyphEditorAdapter } from './GlyphEditorAdapter.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#glyph/workbench/GlyphTranscriptEntry.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';

/** Adapts the host's recoverable state and commands to the workbench interaction port. */
export class NativeGlyphWorkbenchService extends Disposable implements GlyphWorkbenchService {
  private readonly composers = new Map<string, GlyphComposerState>();
  private immediatePending = false;
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = this._register(new Emitter<GlyphWorkbenchState>());
  readonly onDidChangeState = this.changeEmitter.event;
  private readonly projection = new GlyphWorkbenchProjection();
  readonly context: GlyphContextController;
  private readonly shellTerminals: GlyphShellTerminals;
  private readonly proposalEditor: GlyphProposalEditor;
  private readonly client: GlyphDesktopClient;
  private selectionInitialized = false;
  private selectedChatId: string | undefined;
  private openChatIds: string[] = [];
  private archivedChatIds: string[] = [];
  private pinnedChatIds: string[] = [];
  private pendingRunId: string | undefined;
  private pendingCreation: string | undefined;
  private draftAccount: { readonly provider: string; readonly id: string } | undefined;
  private draftModel: string | undefined;
  private draftModels: readonly GlyphModelSummary[] = [];
  private catalogPending = false;
  private modelPending = false;
  private modelRevision = 0;
  private modelOperation: Promise<void> | undefined;
  private catalogOperation: Promise<void> | undefined;
  private catalogRevision = 0;
  private navigationRevision = 0;
  private navigationPending = false;
  private navigationError: string | undefined;
  private sending = false;
  private decidingProposal = false;
  private sessionChanged = false;
  private invalidationMessage = 'Workspace changed. Reload the window to reconnect Glyph.';
  private readonly profileId: string;
  private workspaceBinding: string;
  private readonly editor: GlyphEditorAdapter;
  private workspaceRefresh: Promise<void> | undefined;
  private workspaceBlocked = false;
  private workspaceRevision = 0;
  private workspaceMessage: string | undefined;
  private readonly prompts = new Map<string, string>();
  private readonly errors: GlyphTranscriptEntry[] = [];
  constructor(
    @IStorageService private readonly storageService: IStorageService,
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
    @IEditorService private readonly editors: IEditorService,
    @IClipboardService private readonly clipboard: IClipboardService,
    @IOpenerService private readonly opener: IOpenerService,
    @IConfigurationService private readonly configuration: IConfigurationService,
  ) {
    super();
    this.shellTerminals = this._register(
      instantiationService.createInstance(GlyphShellTerminals, shell => {
        if (
          this.state.readOnly ||
          this.projection.state.shells?.some(value => value.id === shell.id && value.running) !== true
        )
          return;
        void this.stopShell(shell.chatId, shell.id).catch(error => {
          this.report(error);
        });
      }),
    );
    const savedChat = this.storageService.get('glyph.selectedChat', StorageScope.WORKSPACE);
    this.selectionInitialized = savedChat !== undefined;
    this.selectedChatId = (savedChat ?? '') || undefined;
    const savedTabs = this.storageService.getObject<object>('glyph.openChatTabs', StorageScope.WORKSPACE);
    this.openChatIds = Array.isArray(savedTabs)
      ? [...new Set(savedTabs.filter((id): id is string => typeof id === 'string'))]
      : [(savedChat ?? '') || ''];
    for (const key of ['archivedChatIds', 'pinnedChatIds'] as const) {
      const saved = this.storageService.getObject<object>(`glyph.${key}`, StorageScope.WORKSPACE);
      this[key] = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
    }
    this.profileId = this.userDataProfileService.currentProfile.id;
    this.workspaceBinding = this.currentWorkspaceBinding();
    const editor = this._register(instantiationService.createInstance(GlyphEditorAdapter));
    this.editor = editor;
    this.client = this._register(new GlyphDesktopClient(request => editor.handle(request)));
    this.context = this._register(
      instantiationService.createInstance(GlyphContextController, editor, () => this.composer),
    );
    this.proposalEditor = this._register(
      instantiationService.createInstance(GlyphProposalEditor, {
        state: () => this.state,
        composer: () => this.composer,
        report: (error: unknown) => {
          this.report(error);
        },
        annotate: async (
          chatId: string,
          annotation: import('#glyph/protocol/events/GlyphAnnotation.js').GlyphAnnotation,
        ) => {
          if (this.selectedChatId !== chatId) await this.openChat(chatId);
          const composer = this.composer;
          composer.registerAnnotationSource(annotation.sourceId, value => this.proposalEditor.revealAnnotation(value));
          const ordered = {
            ...annotation,
            order:
              Math.max(0, ...(composer.snapshot.document.options?.annotations ?? []).map(value => value.order)) + 1,
          };
          if (ordered.comment) composer.saveAnnotation(ordered);
          else composer.requestAnnotation(ordered);
        },
        read: (chatId: string, proposalId: string, fileId: string) =>
          this.request({ type: GlyphWorkbenchCommandType.READ_PROPOSAL_FILE, chatId, proposalId, fileId }),
        decide: (
          chatId: string,
          items: readonly { proposalId: string; itemId: string }[],
          accept: boolean,
          comment?: string,
        ) => this.decideProposalItems(chatId, items, accept, comment),
      }),
    );
    this._register(
      this.onDidChangeState(() => {
        this.proposalEditor.changed();
      }),
    );
    this._register(
      this.onDidChangeState(() => {
        queueMicrotask(() => {
          this.flushQueues();
        });
      }),
    );
    this._register(
      this.configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('glyph.chat.followUpBehavior')) this.changeEmitter.fire(this.state);
      }),
    );
    this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.invalidateChangedSession()));
    for (const event of [
      this.workspaceContextService.onDidChangeWorkspaceName,
      this.workspaceContextService.onDidChangeWorkbenchState,
    ]) {
      this._register(event(() => this.invalidateChangedSession()));
    }
    this._register(this.userDataProfileService.onDidChangeCurrentProfile(() => this.invalidateChangedSession()));
    this._register(
      this.client.onDidDisconnect(error => {
        editor.invalidate();
        this.pendingRunId = undefined;
        this.projection.accept({
          type: GlyphHostEventType.HOST_STATUS,
          status: GlyphHostStatus.DISCONNECTED,
          message: error.message,
        });
        this.changeEmitter.fire(this.state);
      }),
    );
    this._register(
      this.client.onDidReceiveEvent(envelope => {
        if (this.invalidateChangedSession()) return;
        const event = envelope.event;
        if (event.type === GlyphHostEventType.PROPOSAL_PREVIEW) {
          this.proposalEditor.acceptPreview(event.preview);
          return;
        }
        const previousMode =
          event.type === GlyphHostEventType.CHAT_UPDATED
            ? this.projection.state.chats.find(chat => chat.id === event.chat.id)?.mode
            : undefined;
        this.projection.accept(event);
        this.shellTerminals.update(this.projection.state.shells ?? []);
        switch (event.type) {
          case GlyphHostEventType.INITIAL_STATE:
            if (
              !this.selectionInitialized ||
              (this.selectedChatId !== undefined &&
                this.selectedChatId !== '' &&
                !event.state.chats.some(chat => chat.id === this.selectedChatId))
            ) {
              const restored = event.state.chats[0]?.id;
              if (!this.selectionInitialized && restored) {
                const composer = this.composer;
                this.composers.delete('');
                this.composers.set(restored, composer);
                this.openChatIds = [...new Set(this.openChatIds.map(id => id || restored))];
              }
              this.selectChat(restored);
            }
            this.pendingRunId = undefined;
            break;
          case GlyphHostEventType.CHAT_UPDATED:
            if (event.chat.mode !== undefined && event.chat.mode !== previousMode)
              this.composers.get(event.chat.id)?.setMode(event.chat.mode);
            if (
              this.pendingCreation !== undefined &&
              this.pendingCreation !== '' &&
              event.creationId === this.pendingCreation
            ) {
              const composer =
                this.selectedChatId !== undefined && this.selectedChatId !== '' ? this.createComposer() : this.composer;
              if (this.selectedChatId === undefined || this.selectedChatId === '') {
                this.composers.delete('');
                this.openChatIds = this.openChatIds.map(id => (id === '' ? event.chat.id : id));
              }
              this.composers.set(event.chat.id, composer);
              this.selectChat(event.chat.id);
            }
            break;
          case GlyphHostEventType.CHAT_RESTORED: {
            const composer = this.composers.get(event.chatId);
            const attachments = event.draft.attachments.map(value => ({ ...value, id: value.id ?? generateUuid() }));
            const previews = attachments.map(value => ({ ...value, revision: value.contentRevision }));
            const parts = toGlyphTranscriptParts({
              id: '',
              role: GlyphTranscriptRole.USER,
              text: event.draft.text,
              ...(event.draft.options ? { options: event.draft.options } : {}),
              attachments: previews,
            }).map(part =>
              part.type === 'text'
                ? part
                : {
                    type: 'attachment' as const,
                    attachment: attachments[previews.findIndex(preview => preview === part.attachment)],
                  },
            );
            const end = parts.reduce((size, part) => size + (part.type === 'text' ? part.text.length : 1), 0);
            composer?.restoreDraft({ parts, from: end, to: end, options: { ...event.draft.options } });
            break;
          }
          case GlyphHostEventType.RUN_STATE:
            if (event.run.runId === this.pendingRunId) this.pendingRunId = undefined;
            break;
          default:
            break;
        }
        this.changeEmitter.fire(this.state);
      }),
    );
    this._register(
      this.workspaceTrustService.onDidChangeTrust(() => {
        if (this.invalidateChangedSession()) return;
        editor.invalidate();
        void this.connect().catch(error => {
          this.report(error);
        });
      }),
    );
    if (this.workspaceRoots().length > 0)
      void this.connect().catch(error => {
        this.report(error);
      });
  }
  get followUpBehavior(): GlyphFollowUpBehavior {
    return this.configuration.getValue<GlyphFollowUpBehavior>('glyph.chat.followUpBehavior') ===
      GlyphFollowUpBehavior.SEND_IMMEDIATELY
      ? GlyphFollowUpBehavior.SEND_IMMEDIATELY
      : GlyphFollowUpBehavior.QUEUE;
  }
  get composer(): GlyphComposerState {
    const key = this.selectedChatId ?? '';
    let composer = this.composers.get(key);
    if (!composer) this.composers.set(key, (composer = this.createComposer()));
    const chat = this.projection.state.chats.find(value => value.id === key);
    if (chat?.mode !== undefined) composer.hydrateMode(chat.mode);
    return composer;
  }
  get ideContext() {
    return this.context.ide;
  }
  async attachIdeContext(): Promise<void> {
    const composer = this.composer;
    const document = composer.snapshot.document;
    const attachments = await this.context.selectIdeContext();
    if (composer !== this.composer || document !== composer.snapshot.document)
      throw new Error('The active draft changed during capture. Choose the context again.');
    composer.insertAttachments(attachments);
  }
  attachSelection(): Promise<void> {
    return this.context.attachSelection();
  }
  async attachExplorerResources(resources: readonly string[], newChat: boolean): Promise<void> {
    this.assertSessionBinding();
    if (this.sending || this.navigationPending || this.immediatePending)
      throw new Error('Wait for the current chat transition.');
    const composer = this.composer;
    const document = composer.snapshot.document;
    const revision = this.navigationRevision;
    const attachments = await this.context.captureResources(resources);
    this.assertSessionBinding();
    if (composer !== this.composer || document !== composer.snapshot.document || revision !== this.navigationRevision)
      throw new Error('The active draft changed during capture. Choose the context again.');
    if (this.sending || this.navigationPending || this.immediatePending)
      throw new Error('Wait for the current chat transition.');
    if (newChat) {
      this.newChat();
      this.composer.restoreDraft({ parts: [], from: 0, to: 0, options: {} });
    }
    this.composer.insertAttachments(attachments);
  }
  copyText(text: string): Promise<void> {
    return this.clipboard.writeText(text);
  }

  async openLink(href: string): Promise<void> {
    if (/^https?:\/\//iu.test(href)) {
      const url = new URL(href);
      if (url.username || url.password) throw new Error('Web links cannot contain embedded credentials.');
      if (this.configuration.getValue<boolean>('glyph.preferOpeningWebLinksInGlyph')) {
        await this.editors.openEditor({
          resource: BrowserViewUri.forId(generateUuid()),
          options: { pinned: true, viewState: { url: url.href } },
        });
      } else {
        await this.opener.open(URI.parse(url.href), { allowCommands: false, openExternal: true });
      }
      return;
    }
    const path = href.replace(/#L\d+(?:-L?\d+)?$/u, '');
    const root = this.workspaceContextService.getWorkspace().folders.at(0);
    if (root === undefined || /^(?:[a-z]+:|\/)|(?:^|\/)\.\.(?:\/|$)/iu.test(path))
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This link is not a workspace path.');
    await this.editors.openEditor({ resource: URI.joinPath(root.uri, path) });
  }

  get state(): GlyphWorkbenchState & { readonly openChatIds: readonly string[] } {
    const { selectedAccount: _account, selectedModel: _model, models: _models, ...snapshot } = this.projection.state;
    const runs = snapshot.runs.filter(run => run.chatId === this.selectedChatId);
    const active = runs.find(run => isActive(run.status));
    const transcript: GlyphTranscriptEntry[] = runs.flatMap(run => {
      const prompt = run.userText ?? this.prompts.get(run.runId);
      return [
        ...(prompt !== undefined && prompt !== ''
          ? [
              {
                id: `${run.options?.turnId ?? run.runId}:user`,
                role: (run.options?.turnId ?? run.runId).startsWith('shell-event:')
                  ? GlyphTranscriptRole.DIAGNOSTIC
                  : GlyphTranscriptRole.USER,
                text: prompt,
                ...(run.createdAt !== undefined && run.createdAt !== '' ? { createdAt: run.createdAt } : {}),
                ...(!active && !this.sending && run.checkpointTurnId !== undefined && run.checkpointTurnId !== ''
                  ? { checkpointTurnId: run.checkpointTurnId }
                  : {}),
                ...(run.options ? { options: run.options } : {}),
                ...(run.attachments ? { attachments: run.attachments } : {}),
              },
            ]
          : []),
        ...(run.steering ?? []).map(message => ({
          ...message,
          role: GlyphTranscriptRole.USER,
          steering: true,
        })),
        {
          id: run.options?.turnId ?? run.runId,
          role: GlyphTranscriptRole.ASSISTANT,
          text: run.text,
          ...(run.modeSwaps ? { modeSwaps: run.modeSwaps } : {}),
          ...(run.questionResponses ? { questionResponses: run.questionResponses } : {}),
          ...(run.createdAt !== undefined && run.createdAt !== '' ? { createdAt: run.createdAt } : {}),
          ...(!active && !this.sending && run.checkpointTurnId !== undefined && run.checkpointTurnId !== ''
            ? { checkpointTurnId: run.checkpointTurnId }
            : {}),
          ...(run.usage ? { usage: run.usage } : {}),
          progress: { reasoning: run.reasoning, tools: run.tools, status: run.status },
        },
        ...(run.terminalMessage !== undefined && run.terminalMessage !== ''
          ? [{ id: `${run.runId}:terminal`, role: GlyphTranscriptRole.DIAGNOSTIC, text: run.terminalMessage }]
          : []),
      ];
    });
    if (this.pendingRunId !== undefined && this.pendingRunId !== '' && this.prompts.has(this.pendingRunId))
      transcript.push({
        id: `${this.pendingRunId}:user`,
        role: GlyphTranscriptRole.USER,
        text: this.prompts.get(this.pendingRunId)!,
      });
    return {
      ...snapshot,
      readOnly: snapshot.readOnly || this.workspaceBlocked,
      workspaceRetryable: this.workspaceBlocked && !this.workspaceRefresh && this.workspaceRoots().length > 0,
      openChatIds: [...new Set([...this.openChatIds, this.selectedChatId ?? ''])].filter(
        id => !id || snapshot.chats.some(chat => chat.id === id),
      ),
      archivedChatIds: this.archivedChatIds,
      pinnedChatIds: this.pinnedChatIds,
      models: this.draftModels,
      ...(this.draftAccount ? { selectedAccount: this.draftAccount } : {}),
      ...(this.draftModel !== undefined && this.draftModel !== '' ? { selectedModel: this.draftModel } : {}),
      catalogPending: this.catalogPending || this.modelPending,
      navigationPending: this.navigationPending || this.sending || this.workspaceBlocked,
      ...(this.workspaceMessage !== undefined && this.workspaceMessage !== ''
        ? { workspaceMessage: this.workspaceMessage }
        : {}),
      ...(this.navigationError !== undefined && this.navigationError !== ''
        ? { navigationError: this.navigationError }
        : {}),
      status: this.workbenchStatus(active?.status),
      transcript: [
        ...transcript,
        ...this.projection.diagnostics.map((text, index) => ({
          id: `host:${index}`,
          role: GlyphTranscriptRole.DIAGNOSTIC,
          text,
        })),
        ...this.errors,
      ],
      usage: this.projection.usage,
      ...(this.selectedChatId !== undefined && this.selectedChatId !== ''
        ? { selectedChatId: this.selectedChatId }
        : {}),
    };
  }

  async connect(): Promise<void> {
    if (this.workspaceBlocked && !this.workspaceRefresh && this.workspaceRoots().length > 0) this.refreshWorkspace();
    if (this.workspaceRefresh) await this.workspaceRefresh;
    this.assertSessionBinding();
    await this.client.connect(this.workspaceRoots(), this.workspaceTrustService.isWorkspaceTrusted());
    this.assertSessionBinding();
    await this.hydrateSelectedChat();
    if (
      (this.selectedChatId === undefined || this.selectedChatId === '') &&
      !this.draftAccount &&
      !this.catalogPending
    ) {
      const account = this.projection.state.accounts.find(value => value.connected && value.inferenceAccess);
      if (account) await this.selectAccount(account.provider, account.id);
    }
  }

  async selectMode(mode: AgentModeID): Promise<void> {
    const composer = this.composer;
    if (this.selectedChatId !== undefined && this.selectedChatId !== '')
      await this.request({ type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId: this.selectedChatId, mode });
    composer.setMode(mode);
  }

  async viewPlan(chatId: string, plan: GlyphPlan): Promise<void> {
    this.composer.registerAnnotationSource(plan.id, async () => {
      await this.viewPlan(chatId, plan);
      return undefined;
    });
    const read = () => {
      const chat = this.state.chats.find(chat => chat.id === chatId);
      const current = chat?.plans?.findLast(value => value.id === plan.id) ?? plan;
      return {
        plan: current,
        modelLabel: this.state.models.find(model => model.slug === chat?.modelSlug)?.name ?? chat?.modelSlug,
        disabled: this.state.readOnly || this.state.runs.some(run => run.chatId === chatId && isActive(run.status)),
        agents: current.agents.map(agent => ({
          ...agent,
          title: this.state.chats.find(candidate => candidate.id === agent.chatId)?.title ?? 'Chat unavailable',
        })),
      };
    };
    await this.editors.openEditor(
      new GlyphPlanInput(
        read,
        {
          update: value => this.request({ type: GlyphWorkbenchCommandType.UPDATE_PLAN, chatId, plan: value }),
          build: newChat => this.buildPlan(chatId, read().plan, newChat),
          newAgent: async () => {
            await this.linkPlanChat(chatId, read().plan);
          },
          openChat: id => this.openChat(id),
          openLink: href => this.openLink(href),
          copyText: text => this.copyText(text),
        },
        listener => this.onDidChangeState(listener),
      ),
      { pinned: true },
    );
  }

  async buildPlan(chatId: string, plan: GlyphPlan, newChat = false): Promise<void> {
    const workspaceRevision = this.workspaceRevision;
    const latest = this.state.chats.find(chat => chat.id === chatId)?.plans?.findLast(value => value.id === plan.id);
    if (!latest || latest.revision !== plan.revision)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The plan changed. Review its current revision before building.',
      );
    let targetChatId = chatId;
    let composer: GlyphComposerState;
    if (newChat) {
      const chat = this.state.chats.find(value => value.id === chatId)!;
      targetChatId = await this.createChatTarget(chat.accountProvider, chat.accountId, chat.modelSlug);
      this.assertWorkspaceRevision(workspaceRevision);
      composer = this.composers.get(targetChatId)!;
    } else {
      if (this.selectedChatId !== chatId) await this.openChat(chatId);
      this.assertWorkspaceRevision(workspaceRevision);
      if (this.selectedChatId !== chatId || this.navigationPending)
        throw new Error(this.navigationError ?? 'The plan chat could not be selected. Try building again.');
      composer = this.composer;
    }
    await this.request({
      type: GlyphWorkbenchCommandType.SET_CHAT_MODE,
      chatId: targetChatId,
      mode: AgentModeID.AGENT,
    });
    this.assertWorkspaceRevision(workspaceRevision);
    composer.setMode(AgentModeID.AGENT);
    const document = composer.snapshot.document;
    const text = `\n\n${this.planPrompt(plan, 'Build this approved plan')}`;
    composer.setDocument({ ...document, parts: [...document.parts, { type: 'text', text }] });
    await this.request({
      type: GlyphWorkbenchCommandType.LINK_PLAN,
      chatId,
      planId: plan.id,
      targetChatId,
      role: 'Builder',
    });
    this.assertWorkspaceRevision(workspaceRevision);
    await composer.submit((submittedText, attachments, options) => {
      if (this.immediatePending) throw new Error('Waiting for the current response to stop.');
      return this.sendToChat(submittedText, attachments, options, targetChatId);
    });
  }

  async send(
    text: string,
    attachments: readonly GlyphContextAttachment[] = [],
    options: GlyphTurnOptions = {},
  ): Promise<void> {
    if (this.immediatePending) throw new Error('Waiting for the current response to stop.');
    await this.sendToChat(text, attachments, options);
  }
  async sendImmediately(
    text: string,
    attachments: readonly GlyphContextAttachment[] = [],
    options: GlyphTurnOptions = {},
  ): Promise<void> {
    this.assertSessionBinding();
    if (this.immediatePending || this.navigationPending) throw new Error('A chat transition is already in progress.');
    const chatId = this.selectedChatId;
    const workspaceRevision = this.workspaceRevision;
    const run = this.projection.state.runs.find(value => value.chatId === chatId && isActive(value.status));
    this.immediatePending = true;
    try {
      if (run) {
        await this.request({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: run.chatId, runId: run.runId });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            listener.dispose();
            reject(new Error('The response has not stopped yet. Your message was retained.'));
          }, 30000);
          const check = () => {
            if (this.projection.status === GlyphHostStatus.DISCONNECTED || this.sessionChanged) {
              clearTimeout(timeout);
              listener.dispose();
              reject(new Error('Glyph disconnected while stopping the response.'));
              return;
            }
            if (!this.projection.state.runs.some(value => value.runId === run.runId && isActive(value.status))) {
              clearTimeout(timeout);
              listener.dispose();
              resolve();
            }
          };
          const listener = this.onDidChangeState(check);
          check();
        });
      }
      this.assertWorkspaceRevision(workspaceRevision);
      await this.sendToChat(text, attachments, options, chatId);
    } finally {
      this.immediatePending = false;
      queueMicrotask(() => {
        this.flushQueues();
      });
    }
  }

  async steer(
    text: string,
    attachments: readonly GlyphContextAttachment[] = [],
    options: GlyphTurnOptions = {},
  ): Promise<void> {
    this.assertSessionBinding();
    const unavailableMessage = attachments
      .map(value => value.unavailable)
      .find(message => message !== undefined && message !== '');
    if (unavailableMessage !== undefined) throw new Error(unavailableMessage);
    const run = this.projection.state.runs.find(
      value => value.chatId === this.selectedChatId && isActive(value.status),
    );
    if (!run || this.navigationPending) throw new Error('There is no active response to steer.');
    if (this.projection.state.readOnly) throw new Error('Another window owns this workspace’s Glyph session.');
    await this.request({
      type: GlyphWorkbenchCommandType.STEER,
      chatId: run.chatId,
      runId: run.runId,
      messageId: generateUuid(),
      text: text.trim(),
      attachments,
      options,
    });
  }

  async startAgentReview(review: AgentReviewInput): Promise<void> {
    const chat = this.state.chats.find(chat => chat.id === this.selectedChatId);
    const account = chat ? { provider: chat.accountProvider, id: chat.accountId } : this.state.selectedAccount;
    const model = chat?.modelSlug ?? this.state.selectedModel;
    if (!account || model === undefined || model === '')
      throw new Error('Choose an account and model before reviewing.');
    await this.request({
      type: GlyphWorkbenchCommandType.START_AGENT_REVIEW,
      review,
      model: { accountProvider: account.provider, accountId: account.id, model },
    });
  }
  cancelAgentReview(reviewId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.CANCEL_AGENT_REVIEW, reviewId });
  }
  dismissAgentReviewFinding(reviewId: string, findingId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.DISMISS_AGENT_REVIEW_FINDING, reviewId, findingId });
  }

  cancelRun(chatId: string, runId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId, runId });
  }

  cancel(): void {
    if (this.composer.snapshot.queued.length > 0) this.composer.pauseQueue();
    const run = this.projection.state.runs.find(run => run.chatId === this.selectedChatId && isActive(run.status));
    const runId = run?.runId ?? this.pendingRunId;
    if (runId === undefined || runId === '' || this.selectedChatId === undefined || this.selectedChatId === '') return;
    void this.request({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: this.selectedChatId, runId }).catch(
      error => {
        this.report(error);
      },
    );
  }

  /** Draft setup belongs to this window; saved chats retain their original account/model. */
  async selectAccount(provider: string, accountId: string): Promise<void> {
    this.assertSessionBinding();
    if (this.selectedChatId !== undefined && this.selectedChatId !== '') return;
    const revision = ++this.catalogRevision;
    this.modelOperation = undefined;
    this.modelRevision++;
    this.modelPending = false;
    this.draftAccount = { provider, id: accountId };
    this.draftModel = undefined;
    this.draftModels = [];
    this.catalogPending = true;
    this.navigationError = undefined;
    this.changeEmitter.fire(this.state);
    return (this.catalogOperation = this.loadModels(provider, accountId, revision));
  }
  async selectModel(model: string): Promise<void> {
    this.assertSessionBinding();
    this.modelPending = true;
    this.changeEmitter.fire(this.state);
    return (this.modelOperation = this.changeModel(model, this.catalogRevision, ++this.modelRevision));
  }

  async moveQueuedToNewChat(id: string): Promise<void> {
    this.assertSessionBinding();
    if (this.sending || this.navigationPending || this.immediatePending)
      throw new Error('Wait for the current chat transition.');
    const source = this.composer;
    const message = source.snapshot.queued.find(value => value.id === id);
    if (
      !message ||
      (source.snapshot.queueSubmitting !== undefined && source.snapshot.queueSubmitting !== '') ||
      (source.snapshot.editingQueuedMessage !== undefined && source.snapshot.editingQueuedMessage !== '')
    )
      return;
    this.newChat();
    this.composer.restoreDraft(structuredClone(message.document));
    source.removeQueued(id);
    this.composer.focus();
  }

  newChat(): void {
    if (this.invalidateChangedSession() || this.workspaceBlocked) return;
    if (this.sending) return;
    this.navigationRevision++;
    this.navigationPending = false;
    this.navigationError = undefined;
    this.selectChat(undefined);
    this.changeEmitter.fire(this.state);
    void this.connect().catch(error => {
      this.report(error);
    });
  }

  async setChatArchived(chatId: string, archived: boolean): Promise<void> {
    if (this.state.readOnly || this.navigationPending || this.sending) return;
    if (archived) await this.closeChat(chatId);
    this.archivedChatIds = this.archivedChatIds.filter(id => id !== chatId);
    if (archived) this.archivedChatIds.push(chatId);
    this.storageService.store(
      'glyph.archivedChatIds',
      this.archivedChatIds,
      StorageScope.WORKSPACE,
      StorageTarget.MACHINE,
    );
    this.changeEmitter.fire(this.state);
  }
  setChatPinned(chatId: string, pinned: boolean): void {
    this.pinnedChatIds = this.pinnedChatIds.filter(id => id !== chatId);
    if (pinned) this.pinnedChatIds.push(chatId);
    this.storageService.store('glyph.pinnedChatIds', this.pinnedChatIds, StorageScope.WORKSPACE, StorageTarget.MACHINE);
    this.changeEmitter.fire(this.state);
  }

  async closeChat(chatId: string): Promise<void> {
    if (this.sending || this.navigationPending || this.state.readOnly) return;
    const tabs = this.state.openChatIds;
    const index = tabs.indexOf(chatId);
    if (index < 0) return;
    const remaining = tabs.filter(id => id !== chatId);
    if ((this.selectedChatId ?? '') === chatId) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) await this.openChat(next);
      else this.newChat();
      if (next && this.selectedChatId !== next) return;
    }
    this.openChatIds = remaining.length > 0 ? [...remaining] : [''];
    this.persistChatTabs();
    this.changeEmitter.fire(this.state);
  }

  async createChat(provider: string, accountId: string, model: string): Promise<void> {
    await this.createChatTarget(provider, accountId, model);
  }

  async branchChat(chatId: string, turnId: string): Promise<void> {
    const creationId = generateUuid();
    if (this.pendingCreation !== undefined && this.pendingCreation !== '') return;
    this.pendingCreation = creationId;
    try {
      await this.request({ type: GlyphWorkbenchCommandType.BRANCH_CHAT, chatId, turnId, creationId });
    } finally {
      this.pendingCreation = undefined;
    }
  }

  async restoreCheckpoint(chatId: string, turnId: string): Promise<void> {
    await this.request({ type: GlyphWorkbenchCommandType.RESTORE_CHECKPOINT, chatId, turnId });
  }

  async openChat(chatId: string): Promise<void> {
    if (this.sending) return;
    const revision = ++this.navigationRevision;
    this.navigationPending = true;
    this.navigationError = undefined;
    this.changeEmitter.fire(this.state);
    try {
      await this.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId });
      this.assertSessionBinding();
      if (revision === this.navigationRevision) this.selectChat(chatId);
    } catch (error) {
      if (revision === this.navigationRevision)
        this.navigationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (revision === this.navigationRevision) {
        this.navigationPending = false;
        this.changeEmitter.fire(this.state);
      }
    }
  }

  writeShellInput(chatId: string, sessionId: string, input: string, appendNewline: boolean): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.WRITE_SHELL_INPUT, chatId, sessionId, input, appendNewline });
  }

  async openShell(chatId: string, sessionId: string): Promise<void> {
    this.assertSessionBinding();
    const shell = this.projection.state.shells?.find(value => value.id === sessionId && value.chatId === chatId);
    if (!shell) throw new Error('This background terminal is no longer available.');
    await this.shellTerminals.open(shell);
  }

  stopShell(chatId: string, sessionId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.STOP_SHELL_SESSION, chatId, sessionId });
  }

  answerQuestion(chatId: string, runId: string, questionId: string, answer: unknown): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.ANSWER_QUESTION, chatId, runId, questionId, answer });
  }

  decideApproval(chatId: string, runId: string, approvalId: string, decision: GlyphApprovalDecision): Promise<void> {
    return this.request({
      type: GlyphWorkbenchCommandType.DECIDE_APPROVAL,
      chatId,
      runId,
      approvalId,
      decision,
    });
  }

  executeReviewCommand(command: GlyphReviewCommand): void {
    this.proposalEditor.executeCommand(command);
  }

  reviewProposalFile(chatId: string, proposalId: string, fileId: string): Promise<void> {
    return this.proposalEditor.open(chatId, proposalId, fileId);
  }

  async decideProposalItems(
    chatId: string,
    items: readonly { readonly proposalId: string; readonly itemId: string }[],
    accept: boolean,
    comment?: string,
  ): Promise<void> {
    if (this.decidingProposal)
      throw new GlyphProposalReviewError(
        GlyphDesktopErrorCode.CHAT_BUSY,
        'Another review decision is still being saved.',
      );
    this.decidingProposal = true;
    try {
      for (const item of accept ? items : items.toReversed()) {
        if (accept) await this.acceptProposalItem(chatId, item.proposalId, item.itemId);
        else await this.rejectProposalItem(chatId, item.proposalId, item.itemId, comment);
      }
    } finally {
      this.decidingProposal = false;
    }
    await this.proposalEditor.refresh();
  }

  acceptProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM, chatId, proposalId, itemId });
  }

  rejectProposalItem(chatId: string, proposalId: string, itemId: string, comment?: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM, chatId, proposalId, itemId, comment });
  }

  override dispose(): void {
    this.sessionChanged = true;
    super.dispose();
  }

  private createComposer(): GlyphComposerState {
    const composer = new GlyphComposerState();
    this._register({
      dispose: composer.subscribe(() => {
        queueMicrotask(() => {
          this.flushQueues();
        });
      }),
    });
    return composer;
  }

  private flushQueues(): void {
    if (
      this.sessionChanged ||
      this.workspaceBlocked ||
      this.sending ||
      this.navigationPending ||
      (this.pendingRunId !== undefined && this.pendingRunId !== '') ||
      this.immediatePending ||
      this.projection.status !== GlyphHostStatus.READY ||
      this.projection.state.readOnly
    )
      return;
    for (const [chatId, composer] of this.composers) {
      const state = composer.snapshot;
      const first = state.queued.at(0);
      if (
        !chatId ||
        first === undefined ||
        state.queuePaused ||
        (state.queueSubmitting !== undefined && state.queueSubmitting !== '') ||
        (state.editingQueuedMessage !== undefined && state.editingQueuedMessage !== '') ||
        state.submitting ||
        this.projection.state.runs.some(run => run.chatId === chatId && isActive(run.status))
      )
        continue;
      void composer
        .sendQueued(first.id, (text, attachments, options) => this.sendToChat(text, attachments, options, chatId))
        .then(() => {
          if (
            composer.snapshot.queueError !== undefined &&
            composer.snapshot.queueError !== '' &&
            this.projection.state.runs.some(run => run.chatId === chatId && isActive(run.status))
          )
            composer.resumeQueue();
        });
      return;
    }
  }

  /** Human decisions keep their distinct state instead of looking like ordinary streaming. */
  private workbenchStatus(activeStatus: GlyphRunStatus | undefined): GlyphWorkbenchStatus {
    if (this.sessionChanged || this.workspaceBlocked) return GlyphWorkbenchStatus.DISCONNECTED;
    switch (activeStatus) {
      case GlyphRunStatus.WAITING_FOR_QUESTION:
        return GlyphWorkbenchStatus.WAITING_FOR_QUESTION;
      case GlyphRunStatus.WAITING_FOR_APPROVAL:
        return GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
      default:
        break;
    }
    if (activeStatus !== undefined || (this.pendingRunId !== undefined && this.pendingRunId !== ''))
      return GlyphWorkbenchStatus.STREAMING;
    return this.projection.status === GlyphHostStatus.READY
      ? GlyphWorkbenchStatus.READY
      : GlyphWorkbenchStatus.DISCONNECTED;
  }

  /** Replacement runtimes recover durable history separately from their live-run snapshot. */
  private async hydrateSelectedChat(): Promise<void> {
    if (
      this.selectedChatId !== undefined &&
      this.selectedChatId !== '' &&
      !this.projection.state.runs.some(run => run.chatId === this.selectedChatId)
    ) {
      await this.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: this.selectedChatId });
    }
  }

  private async createChatTarget(provider: string, accountId: string, model: string): Promise<string> {
    if (this.pendingCreation !== undefined && this.pendingCreation !== '')
      throw new Error('Another chat is being created. Try again when it finishes.');
    const creationId = generateUuid();
    let createdChatId: string | undefined;
    const listener = this.client.onDidReceiveEvent(({ event }) => {
      if (event.type === GlyphHostEventType.CHAT_UPDATED && event.creationId === creationId)
        createdChatId = event.chat.id;
    });
    this.pendingCreation = creationId;
    try {
      await this.request({
        type: GlyphWorkbenchCommandType.CREATE_CHAT,
        creationId,
        accountProvider: provider,
        accountId,
        model,
      });
      if (createdChatId === undefined || createdChatId === '')
        throw new Error('The new chat was not acknowledged. Try again.');
      return createdChatId;
    } finally {
      listener.dispose();
      this.pendingCreation = undefined;
    }
  }

  private async linkPlanChat(chatId: string, plan: GlyphPlan): Promise<string> {
    const workspaceRevision = this.workspaceRevision;
    const chat = this.state.chats.find(value => value.id === chatId);
    if (!chat) throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'The plan chat is unavailable.');
    const targetChatId = await this.createChatTarget(chat.accountProvider, chat.accountId, chat.modelSlug);
    this.assertWorkspaceRevision(workspaceRevision);
    const composer = this.composers.get(targetChatId)!;
    await this.request({
      type: GlyphWorkbenchCommandType.LINK_PLAN,
      chatId,
      planId: plan.id,
      targetChatId,
      role: 'Reviewer',
    });
    this.assertWorkspaceRevision(workspaceRevision);
    composer.setMode(AgentModeID.PLAN);
    composer.setDraft(this.planPrompt(plan, 'Review this plan'));
    composer.focus();
    return targetChatId;
  }

  private planPrompt(plan: GlyphPlan, intent: string): string {
    return `${intent}: ${plan.title} (plan ${plan.id}, revision ${plan.revision}).\n\n${plan.markdown}\n\nTodos:\n${plan.todos.map(todo => `- [${todo.completed ? 'x' : ' '}] ${todo.text}`).join('\n')}`;
  }

  private async sendToChat(
    text: string,
    attachments: readonly GlyphContextAttachment[] = [],
    options: GlyphTurnOptions = {},
    targetChatId = this.selectedChatId,
  ): Promise<void> {
    if (this.workspaceRevision)
      attachments = attachments.map(value =>
        URI.parse(value.uri).scheme === 'file' ? this.context.rebindAttachment(value) : value,
      );
    const unavailable = attachments
      .map(value => value.unavailable)
      .find(message => message !== undefined && message !== '');
    if (unavailable !== undefined) throw new Error(unavailable);
    const bytes = attachments.reduce(
      (total, attachment) => total + new TextEncoder().encode(attachment.text).byteLength,
      0,
    );
    if (attachments.length > 32 || bytes > 2 * 1024 * 1024)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'Reduce the selected context to at most 32 attachments and 2 MiB before sending.',
      );
    // Retained runs belong to the retired workspace. Reject before the active
    // run guard so the composer retains a prompt submitted after invalidation.
    this.assertSessionBinding();
    const prompt = text.trim();
    if (
      !prompt ||
      this.sending ||
      this.navigationPending ||
      (this.pendingRunId !== undefined && this.pendingRunId !== '') ||
      this.projection.state.runs.some(run => run.chatId === targetChatId && isActive(run.status))
    )
      throw new Error('The chat is busy. Queue the message or send it immediately.');
    this.sending = true;
    const workspaceRevision = this.workspaceRevision;
    try {
      await this.connect();
      this.assertWorkspaceRevision(workspaceRevision);
      if (this.projection.state.readOnly) throw new Error('Another window owns this workspace’s Glyph session.');
      if (targetChatId === undefined || targetChatId === '') {
        await this.catalogOperation;
        await this.modelOperation;
        this.assertWorkspaceRevision(workspaceRevision);
        const account = this.draftAccount;
        if (!account) throw new Error('Sign in to a Glyph account with inference access before sending a message.');
        if (this.draftModel === undefined || this.draftModel === '')
          throw new Error(this.navigationError ?? 'No models are available for the selected account.');
        await this.createChat(account.provider, account.id, this.draftModel);
        this.assertWorkspaceRevision(workspaceRevision);
        targetChatId = this.selectedChatId;
      }
      const chatId = targetChatId;
      if (chatId === undefined || chatId === '') throw new Error('Create or open a chat before sending.');
      if (options.mode !== undefined && this.state.chats.find(chat => chat.id === chatId)?.mode !== options.mode)
        await this.request({ type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId, mode: options.mode });
      this.assertWorkspaceRevision(workspaceRevision);
      const runId = generateUuid();
      if (chatId === this.selectedChatId) this.pendingRunId = runId;
      this.prompts.set(runId, prompt);
      this.changeEmitter.fire(this.state);
      await this.request({
        type: GlyphWorkbenchCommandType.SEND,
        modeSwapPolicy: {
          autoApprove: this.configuration.getValue<boolean>('glyph.modeSwitch.autoApprove'),
          timeoutSeconds: this.configuration.getValue<number>('glyph.modeSwitch.timeoutSeconds'),
        },
        chatId,
        runId,
        text: prompt,
        attachments,
        options,
      });
    } catch (error) {
      this.pendingRunId = undefined;
      if (!this.projection.state.runs.some(run => run.chatId === targetChatId && isActive(run.status)))
        this.report(error);
      // The composer owns its draft and restores it when submission fails.
      throw error;
    } finally {
      this.sending = false;
      this.changeEmitter.fire(this.state);
    }
  }
  private currentWorkspaceBinding(): string {
    const workspace = this.workspaceContextService.getWorkspace();
    return JSON.stringify([
      workspace.id,
      workspace.configuration?.toString(),
      workspace.folders.map(folder => [folder.name, folder.uri.toString()]),
    ]);
  }
  private invalidateChangedSession(): boolean {
    if (this.userDataProfileService.currentProfile.id !== this.profileId)
      this.invalidateSession('Profile changed. Reload the window to reconnect Glyph.');
    if (this.currentWorkspaceBinding() !== this.workspaceBinding && !this.sessionChanged) {
      this.refreshWorkspace();
      return true;
    }
    return this.sessionChanged;
  }
  private assertSessionBinding(): void {
    if (this.invalidateChangedSession())
      throw new Error(this.sessionChanged ? this.invalidationMessage : this.workspaceMessage);
    if (this.workspaceBlocked) throw new Error(this.workspaceMessage);
  }

  private refreshWorkspace(): void {
    if (this.workspaceRefresh || this.sessionChanged) return;
    this.workspaceBlocked = true;
    this.selectionInitialized = true;
    this.workspaceRevision++;
    this.workspaceMessage = 'Updating workspace folders…';
    this.editor.invalidate();
    this.navigationRevision++;
    this.catalogRevision++;
    this.modelRevision++;
    this.catalogOperation = undefined;
    this.modelOperation = undefined;
    for (const composer of this.composers.values()) composer.pauseQueue();
    this.changeEmitter.fire(this.state);
    let attempted = this.currentWorkspaceBinding();
    this.workspaceRefresh = Promise.resolve()
      .then(async () => {
        do {
          attempted = this.currentWorkspaceBinding();
          try {
            await this.client.detachWorkspace();
            if (this.sessionChanged) return;
            // Capture the latest folders after draining: another edit may have
            // arrived while the old run was checkpointing its final result.
            attempted = this.currentWorkspaceBinding();
            this.workspaceBinding = attempted;
            this.editor.rebindWorkspace();
            for (const composer of this.composers.values())
              composer.mapAttachments(value => this.context.rebindAttachment(value));
            const roots = this.workspaceRoots();
            if (roots.length === 0) {
              this.workspaceMessage =
                'Add a local workspace folder to continue. Your conversation and draft are preserved.';
              return;
            }
            await this.client.connect(roots, this.workspaceTrustService.isWorkspaceTrusted());
            if (attempted !== this.currentWorkspaceBinding()) continue;
            if (this.selectedChatId !== undefined && this.selectedChatId !== '')
              await this.client.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: this.selectedChatId });
            if (this.draftAccount && this.workspaceTrustService.isWorkspaceTrusted())
              await this.client.request({
                type: GlyphWorkbenchCommandType.SELECT_ACCOUNT,
                accountProvider: this.draftAccount.provider,
                accountId: this.draftAccount.id,
              });
            if (
              this.draftModel !== undefined &&
              this.draftModel !== '' &&
              this.workspaceTrustService.isWorkspaceTrusted()
            )
              await this.client.request({ type: GlyphWorkbenchCommandType.SELECT_MODEL, model: this.draftModel });
            if (attempted !== this.currentWorkspaceBinding()) continue;
            this.persistChatTabs();
            this.storageService.store(
              'glyph.selectedChat',
              this.selectedChatId ?? '',
              StorageScope.WORKSPACE,
              StorageTarget.MACHINE,
            );
            this.workspaceBlocked = false;
            this.workspaceMessage = `Workspace updated: ${roots.map(root => root.name).join(', ')}. Continue when ready.`;
          } catch (error) {
            if (attempted !== this.currentWorkspaceBinding()) continue;
            this.workspaceMessage = `Could not update workspace folders: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
        } while (attempted !== this.currentWorkspaceBinding());
      })
      .finally(() => {
        this.workspaceRefresh = undefined;
        this.pendingRunId = undefined;
        this.navigationPending = false;
        this.catalogPending = false;
        this.modelPending = false;
        this.changeEmitter.fire(this.state);
        if (!this.sessionChanged && attempted !== this.currentWorkspaceBinding()) this.refreshWorkspace();
      });
  }
  private assertWorkspaceRevision(revision: number): void {
    this.assertSessionBinding();
    if (revision !== this.workspaceRevision)
      throw new Error('Workspace changed while the action was pending. Please try again.');
  }

  private async request(command: GlyphWorkbenchCommand): Promise<void> {
    this.assertSessionBinding();
    const revision = this.workspaceRevision;
    await this.client.connect(this.workspaceRoots(), this.workspaceTrustService.isWorkspaceTrusted());
    // A completed rebind is still a different authority from the one this action started with.
    this.assertWorkspaceRevision(revision);
    return this.client.request(command);
  }
  private invalidateSession(message = 'Workspace changed. Reload the window to reconnect Glyph.'): void {
    if (this.sessionChanged) return;
    this.sessionChanged = true;
    this.invalidationMessage = message;
    this.pendingRunId = undefined;
    // Profiles have separate accounts and history. Retire this port until reload.
    this.client.dispose();
    this.report(new Error(this.invalidationMessage));
  }
  private async loadModels(provider: string, accountId: string, revision: number): Promise<void> {
    try {
      await this.request({ type: GlyphWorkbenchCommandType.SELECT_ACCOUNT, accountProvider: provider, accountId });
      if (revision !== this.catalogRevision) return;
      await this.request({ type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT, afterSequence: 0 });
      if (revision !== this.catalogRevision) return;
      this.draftModels = this.projection.state.models;
      this.draftModel = this.draftModels[0]?.slug;
      if (!this.draftModel) this.navigationError = 'No models are available for this account.';
    } catch (error) {
      if (revision === this.catalogRevision)
        this.navigationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (revision === this.catalogRevision) {
        this.catalogPending = false;
        this.changeEmitter.fire(this.state);
      }
    }
  }
  private async changeModel(model: string, revision: number, modelRevision: number): Promise<void> {
    try {
      await this.connect();
      if (revision !== this.catalogRevision || modelRevision !== this.modelRevision) return;
      const account = this.draftAccount;
      const selected = this.projection.state.selectedAccount;
      // A replacement host has no catalog even when this window still owns a draft.
      if (account && (selected?.provider !== account.provider || selected?.id !== account.id)) {
        await this.request({
          type: GlyphWorkbenchCommandType.SELECT_ACCOUNT,
          accountProvider: account.provider,
          accountId: account.id,
        });
        if (revision !== this.catalogRevision || modelRevision !== this.modelRevision) return;
        await this.request({ type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT, afterSequence: 0 });
      }
      if (revision !== this.catalogRevision || modelRevision !== this.modelRevision) return;
      await this.request({ type: GlyphWorkbenchCommandType.SELECT_MODEL, model });
      this.assertSessionBinding();
      if (revision !== this.catalogRevision || modelRevision !== this.modelRevision) return;
      this.draftModel = model;
      this.navigationError = undefined;
    } catch (error) {
      if (revision === this.catalogRevision && modelRevision === this.modelRevision) {
        this.draftModel = undefined;
        this.navigationError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      if (modelRevision === this.modelRevision) this.modelPending = false;
      this.changeEmitter.fire(this.state);
    }
  }
  private selectChat(chatId: string | undefined): void {
    this.selectedChatId = chatId;
    if (!this.openChatIds.includes(chatId ?? '')) this.openChatIds.push(chatId ?? '');
    this.persistChatTabs();
    this.selectionInitialized = true;
    this.storageService.store('glyph.selectedChat', chatId ?? '', StorageScope.WORKSPACE, StorageTarget.MACHINE);
  }

  private persistChatTabs(): void {
    this.storageService.store('glyph.openChatTabs', this.openChatIds, StorageScope.WORKSPACE, StorageTarget.MACHINE);
  }

  private workspaceRoots() {
    return this.workspaceContextService
      .getWorkspace()
      .folders.filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ name: folder.name, uri: folder.uri.toString(), canonicalPath: folder.uri.fsPath }));
  }
  private report(error: unknown): void {
    this.errors.push({
      id: generateUuid(),
      role: GlyphTranscriptRole.DIAGNOSTIC,
      text: error instanceof Error ? error.message : String(error),
    });
    this.changeEmitter.fire(this.state);
  }
}

function isActive(status: GlyphRunStatus): boolean {
  return (
    status === GlyphRunStatus.STREAMING ||
    status === GlyphRunStatus.WAITING_FOR_QUESTION ||
    status === GlyphRunStatus.WAITING_FOR_APPROVAL
  );
}
