import { Emitter } from '#vs/base/common/event.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '#vs/platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '#vs/platform/workspace/common/workspaceTrust.js';
import { GlyphWorkbenchProjection } from '#glyph/workbench/GlyphWorkbenchProjection.js';
import { GlyphHostEventType } from '#glyph/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#glyph/protocol/events/GlyphRunProjection.js';
import { GlyphHostStatus } from '#glyph/protocol/events/GlyphHostStatus.js';
import { GlyphWorkbenchCommandType } from '#glyph/protocol/GlyphWorkbenchCommand.js';
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
  declare readonly _serviceBrand: undefined;
  private readonly changeEmitter = this._register(new Emitter<GlyphWorkbenchState>());
  readonly onDidChangeState = this.changeEmitter.event;
  private readonly projection = new GlyphWorkbenchProjection();
  private readonly client: GlyphDesktopClient;
  private selection: GlyphWorkbenchSelection | undefined;
  private selectedChatId: string | undefined;
  private pendingRunId: string | undefined;
  private creatingChat = false;
  private sending = false;
  private workspaceChanged = false;
  private readonly prompts = new Map<string, string>();
  private readonly errors: GlyphTranscriptEntry[] = [];

  constructor(
    @IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
    @IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    const editor = this._register(instantiationService.createInstance(GlyphEditorAdapter));
    this.client = this._register(new GlyphDesktopClient(request => editor.handle(request)));
    this._register(
      this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
        this.workspaceChanged = true;
        // Detach the old runtime too: its index and shell authority still name
        // the original roots even though the editor has already changed folders.
        // TODO: Negotiate a replacement host/editor binding without a window reload.
        this.client.dispose();
        this.report(new Error('Workspace folders changed. Reload the window to reconnect Glyph.'));
      }),
    );
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
        const event = envelope.event;
        this.projection.accept(event);
        switch (event.type) {
          case GlyphHostEventType.INITIAL_STATE:
            if (!event.state.chats.some(chat => chat.id === this.selectedChatId))
              this.selectedChatId = event.state.chats[0]?.id;
            this.pendingRunId = undefined;
            break;
          case GlyphHostEventType.CHAT_UPDATED:
            if (this.creatingChat || !this.selectedChatId) this.selectedChatId = event.chat.id;
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
        if (this.workspaceChanged) return;
        editor.invalidate();
        void this.client
          .request({
            type: GlyphWorkbenchCommandType.ATTACH_WORKSPACE,
            roots: this.workspaceRoots(),
            trusted: this.workspaceTrustService.isWorkspaceTrusted(),
          })
          .catch(error => this.report(error));
      }),
    );
    if (this.workspaceRoots().length > 0) void this.connect().catch(error => this.report(error));
  }

  get state(): GlyphWorkbenchState {
    const snapshot = this.projection.state;
    const runs = snapshot.runs.filter(run => run.chatId === this.selectedChatId);
    const active = runs.find(run => isActive(run.status));
    const transcript: GlyphTranscriptEntry[] = runs.flatMap(run => {
      const prompt = run.userText ?? this.prompts.get(run.runId);
      return [
        ...(prompt ? [{ id: `${run.runId}:user`, role: GlyphTranscriptRole.USER, text: prompt }] : []),
        { id: run.runId, role: GlyphTranscriptRole.ASSISTANT, text: run.text },
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
    if (this.workspaceChanged) throw new Error('Workspace folders changed. Reload the window to reconnect Glyph.');
    await this.client.connect(this.workspaceRoots(), this.workspaceTrustService.isWorkspaceTrusted());
    if (this.selectedChatId && !this.projection.state.runs.some(run => run.chatId === this.selectedChatId)) {
      await this.client.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: this.selectedChatId });
    }
  }
  setSelection(selection: GlyphWorkbenchSelection | undefined): void {
    this.selection = selection;
    this.changeEmitter.fire(this.state);
  }

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (
      !prompt ||
      this.sending ||
      this.pendingRunId ||
      this.projection.state.runs.some(run => run.chatId === this.selectedChatId && isActive(run.status))
    )
      return;
    this.sending = true;
    try {
      await this.connect();
      if (this.projection.state.readOnly) throw new Error('Another window owns this workspace’s Glyph session.');
      if (!this.selectedChatId) {
        const account = this.projection.state.accounts.find(account => account.connected && account.inferenceAccess);
        if (!account) throw new Error('Sign in to a Glyph account with inference access before sending a message.');
        await this.selectAccount(account.provider, account.id);
        const model = this.projection.state.models[0];
        if (!model) throw new Error('No models are available for the selected account.');
        await this.createChat(account.provider, account.id, model.slug);
      }
      const chatId = this.selectedChatId;
      if (!chatId) throw new Error('Create or open a chat before sending.');
      const runId = generateUuid();
      this.pendingRunId = runId;
      this.prompts.set(runId, prompt);
      this.changeEmitter.fire(this.state);
      await this.client.request({
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
    }
  }

  cancel(): void {
    const run = this.projection.state.runs.find(run => run.chatId === this.selectedChatId && isActive(run.status));
    const runId = run?.runId ?? this.pendingRunId;
    if (!runId || !this.selectedChatId) return;
    void this.client
      .request({ type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: this.selectedChatId, runId })
      .catch(error => this.report(error));
  }

  async selectAccount(provider: string, accountId: string): Promise<void> {
    await this.connect();
    await this.client.request({ type: GlyphWorkbenchCommandType.SELECT_ACCOUNT, accountProvider: provider, accountId });
    await this.client.request({ type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT, afterSequence: 0 });
  }
  async selectModel(model: string): Promise<void> {
    await this.client.request({ type: GlyphWorkbenchCommandType.SELECT_MODEL, model });
  }
  async createChat(provider: string, accountId: string, model: string): Promise<void> {
    await this.connect();
    this.creatingChat = true;
    try {
      await this.client.request({
        type: GlyphWorkbenchCommandType.CREATE_CHAT,
        accountProvider: provider,
        accountId,
        model,
      });
    } finally {
      this.creatingChat = false;
    }
  }
  async openChat(chatId: string): Promise<void> {
    await this.connect();
    await this.client.request({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId });
    this.selectedChatId = chatId;
    this.changeEmitter.fire(this.state);
  }
  answerQuestion(chatId: string, runId: string, questionId: string, answer: unknown): Promise<void> {
    return this.client.request({ type: GlyphWorkbenchCommandType.ANSWER_QUESTION, chatId, runId, questionId, answer });
  }
  decideApproval(chatId: string, runId: string, approvalId: string, approved: boolean): Promise<void> {
    return this.client.request({
      type: GlyphWorkbenchCommandType.DECIDE_APPROVAL,
      chatId,
      runId,
      approvalId,
      approved,
    });
  }
  acceptProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void> {
    return this.client.request({ type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM, chatId, proposalId, itemId });
  }
  rejectProposalItem(chatId: string, proposalId: string, itemId: string): Promise<void> {
    return this.client.request({ type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM, chatId, proposalId, itemId });
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
