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
  private readonly proposalEditor: GlyphProposalEditor;
  private readonly client: GlyphDesktopClient;
  private selectionInitialized = false;
  private selectedChatId: string | undefined;
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
  private readonly workspaceBinding: string;
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
    const savedChat = this.storageService.get('glyph.selectedChat', StorageScope.WORKSPACE);
    this.selectionInitialized = savedChat !== undefined;
    this.selectedChatId = savedChat || undefined;
    this.profileId = this.userDataProfileService.currentProfile.id;
    this.workspaceBinding = this.currentWorkspaceBinding();
    const editor = this._register(instantiationService.createInstance(GlyphEditorAdapter));
    this.client = this._register(new GlyphDesktopClient(request => editor.handle(request)));
    this.context = this._register(
      instantiationService.createInstance(GlyphContextController, editor, () => this.composer),
    );
    this.proposalEditor = this._register(
      instantiationService.createInstance(GlyphProposalEditor, {
        state: () => this.state,
        composer: () => this.composer,
        report: (error: unknown) => this.report(error),
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
    this._register(this.onDidChangeState(() => this.proposalEditor.changed()));
    this._register(this.onDidChangeState(() => queueMicrotask(() => this.flushQueues())));
    this._register(
      this.configuration.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('glyph.chat.followUpBehavior')) this.changeEmitter.fire(this.state);
      }),
    );
    this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.invalidateSession()));
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
        switch (event.type) {
          case GlyphHostEventType.INITIAL_STATE:
            if (
              !this.selectionInitialized ||
              (this.selectedChatId && !event.state.chats.some(chat => chat.id === this.selectedChatId))
            ) {
              this.selectedChatId = event.state.chats[0]?.id;
              this.selectionInitialized = true;
            }
            this.pendingRunId = undefined;
            break;
          case GlyphHostEventType.CHAT_UPDATED:
            if (event.chat.mode && event.chat.mode !== previousMode)
              this.composers.get(event.chat.id)?.setMode(event.chat.mode);
            if (this.pendingCreation && event.creationId === this.pendingCreation) {
              const composer = this.selectedChatId ? this.createComposer() : this.composer;
              if (!this.selectedChatId) this.composers.delete('');
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
                    attachment: attachments[previews.indexOf(part.attachment as (typeof previews)[number])]!,
                  },
            );
            const end = parts.reduce((size, part) => size + (part.type === 'text' ? part.text.length : 1), 0);
            composer?.restoreDraft({ parts, from: end, to: end, options: { ...event.draft.options } });
            break;
          }
          case GlyphHostEventType.RUN_STATE:
            if (event.run.runId === this.pendingRunId) this.pendingRunId = undefined;
            break;
        }
        this.changeEmitter.fire(this.state);
      }),
    );
    this._register(
      this.workspaceTrustService.onDidChangeTrust(() => {
        if (this.invalidateChangedSession()) return;
        editor.invalidate();
        void this.connect().catch(error => this.report(error));
      }),
    );
    if (this.workspaceRoots().length > 0) void this.connect().catch(error => this.report(error));
  }
  get followUpBehavior(): GlyphFollowUpBehavior {
    return this.configuration.getValue<string>('glyph.chat.followUpBehavior') === GlyphFollowUpBehavior.SEND_IMMEDIATELY
      ? GlyphFollowUpBehavior.SEND_IMMEDIATELY
      : GlyphFollowUpBehavior.QUEUE;
  }
  get composer(): GlyphComposerState {
    const key = this.selectedChatId ?? '';
    let composer = this.composers.get(key);
    if (!composer) this.composers.set(key, (composer = this.createComposer()));
    const chat = this.projection.state.chats.find(value => value.id === key);
    if (chat?.mode) composer.hydrateMode(chat.mode);
    return composer;
  }
  attachSelection(): Promise<void> {
    return this.context.attachSelection();
  }
  copyText(text: string): Promise<void> {
    return this.clipboard.writeText(text);
  }

  async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href)) {
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
    const path = href.replace(/#L\d+(?:-L?\d+)?$/, '');
    const root = this.workspaceContextService.getWorkspace().folders[0];
    if (!root || /^(?:[a-z]+:|\/)|(?:^|\/)\.\.(?:\/|$)/i.test(path))
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This link is not a workspace path.');
    await this.editors.openEditor({ resource: URI.joinPath(root.uri, path) });
  }

  get state(): GlyphWorkbenchState {
    const { selectedAccount: _account, selectedModel: _model, models: _models, ...snapshot } = this.projection.state;
    const runs = snapshot.runs.filter(run => run.chatId === this.selectedChatId);
    const active = runs.find(run => isActive(run.status));
    const transcript: GlyphTranscriptEntry[] = runs.flatMap(run => {
      const prompt = run.userText ?? this.prompts.get(run.runId);
      return [
        ...(prompt
          ? [
              {
                id: `${run.options?.turnId ?? run.runId}:user`,
                role: GlyphTranscriptRole.USER,
                text: prompt,
                ...(run.createdAt ? { createdAt: run.createdAt } : {}),
                ...(!active && !this.sending && run.checkpointTurnId ? { checkpointTurnId: run.checkpointTurnId } : {}),
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
          ...(run.createdAt ? { createdAt: run.createdAt } : {}),
          ...(!active && !this.sending && run.checkpointTurnId ? { checkpointTurnId: run.checkpointTurnId } : {}),
          ...(run.usage ? { usage: run.usage } : {}),
          progress: { reasoning: run.reasoning, tools: run.tools, status: run.status },
        },
        ...(run.terminalMessage
          ? [{ id: `${run.runId}:terminal`, role: GlyphTranscriptRole.DIAGNOSTIC, text: run.terminalMessage }]
          : []),
      ];
    });
    if (this.pendingRunId && this.prompts.has(this.pendingRunId))
      transcript.push({
        id: `${this.pendingRunId}:user`,
        role: GlyphTranscriptRole.USER,
        text: this.prompts.get(this.pendingRunId)!,
      });
    return {
      ...snapshot,
      models: this.draftModels,
      ...(this.draftAccount ? { selectedAccount: this.draftAccount } : {}),
      ...(this.draftModel ? { selectedModel: this.draftModel } : {}),
      catalogPending: this.catalogPending || this.modelPending,
      navigationPending: this.navigationPending || this.sending,
      ...(this.navigationError ? { navigationError: this.navigationError } : {}),
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
      ...(this.selectedChatId ? { selectedChatId: this.selectedChatId } : {}),
    };
  }

  async connect(): Promise<void> {
    this.assertSessionBinding();
    await this.client.connect(this.workspaceRoots(), this.workspaceTrustService.isWorkspaceTrusted());
    this.assertSessionBinding();
    await this.hydrateSelectedChat();
    if (!this.selectedChatId && !this.draftAccount && !this.catalogPending) {
      const account = this.projection.state.accounts.find(value => value.connected && value.inferenceAccess);
      if (account) await this.selectAccount(account.provider, account.id);
    }
  }

  async selectMode(mode: AgentModeID): Promise<void> {
    const composer = this.composer;
    if (this.selectedChatId)
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
          title: this.state.chats.find(chat => chat.id === agent.chatId)?.title ?? 'Chat unavailable',
        })),
      };
    };
    await this.editors.openEditor(
      new GlyphPlanInput(
        read,
        {
          update: value => this.request({ type: GlyphWorkbenchCommandType.UPDATE_PLAN, chatId, plan: value }),
          build: newChat => this.buildPlan(chatId, read().plan, newChat),
          newAgent: () => this.linkPlanChat(chatId, read().plan),
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
    const latest = this.state.chats.find(chat => chat.id === chatId)?.plans?.findLast(value => value.id === plan.id);
    if (!latest || latest.revision !== plan.revision)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The plan changed. Review its current revision before building.',
      );
    if (newChat) {
      await this.linkPlanChat(chatId, plan);
      this.composer.setDraft('');
    } else if (this.selectedChatId !== chatId) await this.openChat(chatId);
    const composer = this.composer;
    await this.selectMode(AgentModeID.AGENT);
    const document = composer.snapshot.document;
    const text = `\n\n${this.planPrompt(plan, 'Build this approved plan')}`;
    composer.setDocument({ ...document, parts: [...document.parts, { type: 'text', text }] });
    await this.request({
      type: GlyphWorkbenchCommandType.LINK_PLAN,
      chatId,
      planId: plan.id,
      targetChatId: this.selectedChatId!,
      role: 'Builder',
    });
    await composer.submit((text, attachments, options) => this.send(text, attachments, options));
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
      await this.sendToChat(text, attachments, options, chatId);
    } finally {
      this.immediatePending = false;
      queueMicrotask(() => this.flushQueues());
    }
  }

  async steer(
    text: string,
    attachments: readonly GlyphContextAttachment[] = [],
    options: GlyphTurnOptions = {},
  ): Promise<void> {
    this.assertSessionBinding();
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

  cancel(): void {
    if (this.composer.snapshot.queued.length) this.composer.pauseQueue();
    const run = this.projection.state.runs.find(run => run.chatId === this.selectedChatId && isActive(run.status));
    const runId = run?.runId ?? this.pendingRunId;
    if (!runId || !this.selectedChatId) return;
    void this.request({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: this.selectedChatId, runId }).catch(error =>
      this.report(error),
    );
  }

  /** Draft setup belongs to this window; saved chats retain their original account/model. */
  selectAccount(provider: string, accountId: string): Promise<void> {
    if (this.selectedChatId) return Promise.resolve();
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
  selectModel(model: string): Promise<void> {
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
    if (!message || source.snapshot.queueSubmitting || source.snapshot.editingQueuedMessage) return;
    this.newChat();
    this.composer.restoreDraft(structuredClone(message.document));
    source.removeQueued(id);
    this.composer.focus();
  }

  newChat(): void {
    if (this.invalidateChangedSession()) return;
    if (this.sending) return;
    this.navigationRevision++;
    this.navigationPending = false;
    this.navigationError = undefined;
    this.selectChat(undefined);
    this.changeEmitter.fire(this.state);
    void this.connect().catch(error => this.report(error));
  }

  async createChat(provider: string, accountId: string, model: string): Promise<void> {
    const creationId = generateUuid();
    this.pendingCreation = creationId;
    try {
      await this.request({
        type: GlyphWorkbenchCommandType.CREATE_CHAT,
        creationId,
        accountProvider: provider,
        accountId,
        model,
      });
      if (!this.selectedChatId) throw new Error('The new chat was not acknowledged. Try again.');
    } finally {
      this.pendingCreation = undefined;
    }
  }

  async branchChat(chatId: string, turnId: string): Promise<void> {
    const creationId = generateUuid();
    if (this.pendingCreation) return;
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
      for (const item of items) {
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

  private createComposer(): GlyphComposerState {
    const composer = new GlyphComposerState();
    this._register({ dispose: composer.subscribe(() => queueMicrotask(() => this.flushQueues())) });
    return composer;
  }

  private flushQueues(): void {
    if (
      this.sessionChanged ||
      this.sending ||
      this.navigationPending ||
      this.pendingRunId ||
      this.immediatePending ||
      this.projection.status !== GlyphHostStatus.READY ||
      this.projection.state.readOnly
    )
      return;
    for (const [chatId, composer] of this.composers) {
      const state = composer.snapshot;
      const first = state.queued[0];
      if (
        !chatId ||
        !first ||
        state.queuePaused ||
        state.queueSubmitting ||
        state.editingQueuedMessage ||
        state.submitting ||
        this.projection.state.runs.some(run => run.chatId === chatId && isActive(run.status))
      )
        continue;
      void composer.sendQueued(first.id, (text, attachments, options) =>
        this.sendToChat(text, attachments, options, chatId),
      );
      return;
    }
  }

  /** Human decisions keep their distinct state instead of looking like ordinary streaming. */
  private workbenchStatus(activeStatus: GlyphRunStatus | undefined): GlyphWorkbenchStatus {
    if (this.sessionChanged) return GlyphWorkbenchStatus.DISCONNECTED;
    switch (activeStatus) {
      case GlyphRunStatus.WAITING_FOR_QUESTION:
        return GlyphWorkbenchStatus.WAITING_FOR_QUESTION;
      case GlyphRunStatus.WAITING_FOR_APPROVAL:
        return GlyphWorkbenchStatus.WAITING_FOR_APPROVAL;
    }
    if (activeStatus || this.pendingRunId) return GlyphWorkbenchStatus.STREAMING;
    return this.projection.status === GlyphHostStatus.READY
      ? GlyphWorkbenchStatus.READY
      : GlyphWorkbenchStatus.DISCONNECTED;
  }

  /** Replacement runtimes recover durable history separately from their live-run snapshot. */
  private async hydrateSelectedChat(): Promise<void> {
    if (this.selectedChatId && !this.projection.state.runs.some(run => run.chatId === this.selectedChatId)) {
      await this.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: this.selectedChatId });
    }
  }

  private async linkPlanChat(chatId: string, plan: GlyphPlan): Promise<void> {
    const chat = this.state.chats.find(value => value.id === chatId);
    if (!chat) throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'The plan chat is unavailable.');
    await this.createChat(chat.accountProvider, chat.accountId, chat.modelSlug);
    const targetChatId = this.selectedChatId!;
    await this.request({
      type: GlyphWorkbenchCommandType.LINK_PLAN,
      chatId,
      planId: plan.id,
      targetChatId,
      role: 'Reviewer',
    });
    this.composer.setMode(AgentModeID.PLAN);
    this.composer.setDraft(this.planPrompt(plan, 'Review this plan'));
    this.composer.focus();
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
      this.pendingRunId ||
      this.projection.state.runs.some(run => run.chatId === targetChatId && isActive(run.status))
    )
      throw new Error('The chat is busy. Queue the message or send it immediately.');
    this.sending = true;
    try {
      await this.connect();
      if (this.projection.state.readOnly) throw new Error('Another window owns this workspace’s Glyph session.');
      if (!targetChatId) {
        await this.catalogOperation;
        await this.modelOperation;
        const account = this.draftAccount;
        if (!account) throw new Error('Sign in to a Glyph account with inference access before sending a message.');
        if (!this.draftModel)
          throw new Error(this.navigationError ?? 'No models are available for the selected account.');
        await this.createChat(account.provider, account.id, this.draftModel);
        targetChatId = this.selectedChatId;
      }
      const chatId = targetChatId;
      if (!chatId) throw new Error('Create or open a chat before sending.');
      if (options.mode && this.state.chats.find(chat => chat.id === chatId)?.mode !== options.mode)
        await this.request({ type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId, mode: options.mode });
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
    if (this.currentWorkspaceBinding() !== this.workspaceBinding) this.invalidateSession();
    return this.sessionChanged;
  }
  private assertSessionBinding(): void {
    if (this.invalidateChangedSession()) throw new Error(this.invalidationMessage);
  }
  private async request(command: GlyphWorkbenchCommand): Promise<void> {
    this.assertSessionBinding();
    await this.client.connect(this.workspaceRoots(), this.workspaceTrustService.isWorkspaceTrusted());
    // Configuration initialization delays workspace events. Recheck the live
    // identity after attachment settles, immediately before dispatching work.
    this.assertSessionBinding();
    return this.client.request(command);
  }
  private invalidateSession(message = 'Workspace changed. Reload the window to reconnect Glyph.'): void {
    if (this.sessionChanged) return;
    this.sessionChanged = true;
    this.invalidationMessage = message;
    this.pendingRunId = undefined;
    // Saving a workspace or switching profiles can change its storage identity
    // while retaining the renderer. Retire the runtime and its editor capabilities;
    // the replacement binding is established when the window reloads.
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
    this.selectionInitialized = true;
    this.storageService.store('glyph.selectedChat', chatId ?? '', StorageScope.WORKSPACE, StorageTarget.MACHINE);
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
