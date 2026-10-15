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
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { GlyphDesktopClient } from '#vs/workbench/contrib/glyph/electron-browser/GlyphDesktopClient.js';
import { GlyphEditorAdapter } from './GlyphEditorAdapter.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#glyph/workbench/GlyphTranscriptEntry.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchSelection } from '#glyph/workbench/GlyphWorkbenchSelection.js';

/** Adapts the host's recoverable state and commands to the workbench interaction port. */
export class NativeGlyphWorkbenchService extends Disposable implements GlyphWorkbenchService {
  private readonly composers = new Map<string, GlyphComposerState>();
  get composer(): GlyphComposerState {
    const key = this.selectedChatId ?? '';
    let composer = this.composers.get(key);
    if (!composer) this.composers.set(key, (composer = new GlyphComposerState()));
    return composer;
  }
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = this._register(new Emitter<GlyphWorkbenchState>());
  readonly onDidChangeState = this.changeEmitter.event;
  private readonly projection = new GlyphWorkbenchProjection();
  private readonly client: GlyphDesktopClient;
  private selection: GlyphWorkbenchSelection | undefined;
  private selectedChatId: string | undefined;
  private pendingRunId: string | undefined;
  private pendingCreation: string | undefined;
  private selectionInitialized = false;
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
  ) {
    super();
    const savedChat = this.storageService.get('glyph.selectedChat', StorageScope.WORKSPACE);
    this.selectionInitialized = savedChat !== undefined;
    this.selectedChatId = savedChat || undefined;
    this.profileId = this.userDataProfileService.currentProfile.id;
    this.workspaceBinding = this.currentWorkspaceBinding();
    const editor = this._register(instantiationService.createInstance(GlyphEditorAdapter));
    this.client = this._register(new GlyphDesktopClient(request => editor.handle(request)));
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
            if (this.pendingCreation && event.creationId === this.pendingCreation) {
              const composer = this.composer;
              this.composers.delete('');
              this.composers.set(event.chat.id, composer);
              this.selectChat(event.chat.id);
            }
            break;
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

  get state(): GlyphWorkbenchState {
    const { selectedAccount: _account, selectedModel: _model, models: _models, ...snapshot } = this.projection.state;
    const runs = snapshot.runs.filter(run => run.chatId === this.selectedChatId);
    const active = runs.find(run => isActive(run.status));
    const transcript: GlyphTranscriptEntry[] = runs.flatMap(run => {
      const prompt = run.userText ?? this.prompts.get(run.runId);
      return [
        ...(prompt ? [{ id: `${run.runId}:user`, role: GlyphTranscriptRole.USER, text: prompt }] : []),
        {
          id: run.runId,
          role: GlyphTranscriptRole.ASSISTANT,
          text: run.text,
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
      ...(this.selection ? { selection: this.selection } : {}),
      ...(this.selectedChatId ? { selectedChatId: this.selectedChatId } : {}),
    };
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

  /** Replacement runtimes recover durable history separately from their live-run snapshot. */
  private async hydrateSelectedChat(): Promise<void> {
    if (this.selectedChatId && !this.projection.state.runs.some(run => run.chatId === this.selectedChatId)) {
      await this.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: this.selectedChatId });
    }
  }
  setSelection(selection: GlyphWorkbenchSelection | undefined): void {
    this.selection = selection;
    this.changeEmitter.fire(this.state);
  }

  async send(text: string): Promise<void> {
    // Retained runs belong to the retired workspace. Reject before the active
    // run guard so the composer retains a prompt submitted after invalidation.
    this.assertSessionBinding();
    const prompt = text.trim();
    if (
      !prompt ||
      this.sending ||
      this.navigationPending ||
      this.pendingRunId ||
      this.projection.state.runs.some(run => run.chatId === this.selectedChatId && isActive(run.status))
    )
      return;
    this.sending = true;
    try {
      await this.connect();
      if (this.projection.state.readOnly) throw new Error('Another window owns this workspace’s Glyph session.');
      if (!this.selectedChatId) {
        await this.catalogOperation;
        await this.modelOperation;
        const account = this.draftAccount;
        if (!account) throw new Error('Sign in to a Glyph account with inference access before sending a message.');
        if (!this.draftModel)
          throw new Error(this.navigationError ?? 'No models are available for the selected account.');
        await this.createChat(account.provider, account.id, this.draftModel);
      }
      const chatId = this.selectedChatId;
      if (!chatId) throw new Error('Create or open a chat before sending.');
      const runId = generateUuid();
      this.pendingRunId = runId;
      this.prompts.set(runId, prompt);
      this.changeEmitter.fire(this.state);
      await this.request({
        type: GlyphWorkbenchCommandType.SEND,
        chatId,
        runId,
        text: prompt,
        attachments: this.selection ? [await toAttachment(this.selection)] : [],
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
    this.selection = undefined;
    this.pendingRunId = undefined;
    // Saving a workspace or switching profiles can change its storage identity
    // while retaining the renderer. Retire the runtime and its editor capabilities;
    // the replacement binding is established when the window reloads.
    this.client.dispose();
    this.report(new Error(this.invalidationMessage));
  }

  cancel(): void {
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

  selectModel(model: string): Promise<void> {
    this.modelPending = true;
    this.changeEmitter.fire(this.state);
    return (this.modelOperation = this.changeModel(model, this.catalogRevision, ++this.modelRevision));
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

  private selectChat(chatId: string | undefined): void {
    this.selectedChatId = chatId;
    this.selectionInitialized = true;
    this.storageService.store('glyph.selectedChat', chatId ?? '', StorageScope.WORKSPACE, StorageTarget.MACHINE);
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
  acceptProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM, chatId, proposalId, itemId });
  }
  rejectProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void> {
    return this.request({ type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM, chatId, proposalId, itemId });
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
async function toAttachment(selection: GlyphWorkbenchSelection): Promise<GlyphContextAttachment> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(selection.text));
  return {
    kind: GlyphContextAttachmentKind.SELECTION,
    uri: selection.uri,
    path: selection.path,
    text: selection.text,
    contentRevision: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    token: {
      workspaceGeneration: 'selection-capture',
      resource: selection.uri,
      incarnation: selection.uri,
      version: selection.version,
    },
  };
}
