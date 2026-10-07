import type { GlyphService } from '../application/GlyphService.ts';
import type { ChatSession } from '../chat/sessions/ChatSession.ts';
import type { ChatAccount } from '../chat/ChatAccount.ts';
import type { Model } from '../chat/Model.ts';
import { describeError } from '../describeError.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import { TerminalActionType } from './TerminalActionType.ts';
import type { TerminalUI } from './TerminalUI.tsx';
import type { TerminalEditReviewer } from './ui/proposal/TerminalEditReviewer.ts';
import type { ProjectContext } from '../project/context/ProjectContext.ts';

interface TerminalApplicationOptions {
  projectContext: ProjectContext;
  configuredModel?: string;
}

/**
 * Terminal host adapter. Slash commands, sequential prompts, and terminal
 * rendering live here rather than in the headless GlyphService.
 */
export class TerminalApplication {
  private activeRequest: AbortController | undefined;
  private conversation: ChatSession | undefined;
  private model: Model | undefined;

  constructor(
    private readonly glyph: GlyphService,
    private readonly ui: TerminalUI,
    private readonly shutdown: AbortSignal,
    private readonly options: TerminalApplicationOptions,
    private readonly reviewer?: TerminalEditReviewer,
  ) {}

  get active(): AbortController | undefined {
    return this.activeRequest;
  }

  async run(): Promise<number> {
    try {
      await this.glyph.initialize();
      if (this.shutdown.aborted) return 0;
      this.ui.showWelcome(
        this.options.projectContext,
        this.glyph.tracePath,
        this.glyph.isTraceEnabled,
        this.glyph.providerPresentation,
      );

      let account = await this.enableInferenceIfNeeded(await this.chooseAccount());
      await this.selectModel(account);
      await this.reviewPending();

      while (!this.shutdown.aborted) {
        const action = await this.ui.nextAction(this.shutdown, this.glyph.proposalReviews?.pendingChangeCount ?? 0);
        switch (action.type) {
          case TerminalActionType.EXIT:
            return 0;
          case TerminalActionType.HELP:
            this.ui.showHelp();
            break;
          case TerminalActionType.RESET:
            await this.requireConversation().reset();
            this.ui.showConversationReset();
            break;
          case TerminalActionType.NEW_CHAT: {
            try {
              const conversation = await this.glyph.createChat(account, this.requireModel());
              this.activateChat(conversation);
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          }
          case TerminalActionType.LIST_CHATS:
            this.ui.showChats(this.glyph.listChats(account), this.conversation?.id);
            break;
          case TerminalActionType.SWITCH_CHAT:
            try {
              this.activateChat(this.glyph.openChat(action.chatId, account));
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          case TerminalActionType.RENAME_CHAT: {
            try {
              const summary = await this.glyph.renameChat(this.requireConversation().id, action.title);
              this.ui.showChatRenamed(summary.title);
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          }
          case TerminalActionType.USAGE:
            this.ui.showUsage(this.glyph.usage);
            break;
          case TerminalActionType.TRACE: {
            const enabled = action.enabled ?? this.glyph.isTraceEnabled;
            this.glyph.setTraceEnabled(enabled);
            this.requireConversation().setTraceEnabled(enabled);
            this.ui.showTrace(enabled, this.glyph.tracePath);
            break;
          }
          case TerminalActionType.LOGOUT:
            this.ui.showLogout(await this.glyph.logout(account));
            return 0;
          case TerminalActionType.REVIEW:
            await this.reviewPending();
            break;
          case TerminalActionType.ACCEPT_ALL:
            try {
              await this.glyph.proposalReviews?.acceptAll();
              await this.flushReviewResults();
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          case TerminalActionType.REJECT_ALL:
            try {
              await this.glyph.proposalReviews?.rejectAll();
              await this.flushReviewResults();
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          case TerminalActionType.ACCOUNT:
          case TerminalActionType.LOGIN: {
            const next =
              action.type === TerminalActionType.ACCOUNT
                ? await this.chooseAccount()
                : await this.glyph.signIn(account, !this.glyph.hasInferenceAccess(account), request =>
                    this.ui.authorize(request),
                  );
            account = await this.enableInferenceIfNeeded(next);
            await this.selectModel(account);
            break;
          }
          case TerminalActionType.UNKNOWN_COMMAND:
            this.ui.showUnknownCommand();
            break;
          case TerminalActionType.SEND:
            await this.send(action.prompt, action.attachmentPaths);
            break;
        }
      }
      return 0;
    } catch (error) {
      if (!this.shutdown.aborted) this.ui.showError(this.glyph.redact(describeError(error)));
      return this.shutdown.aborted ? 0 : 1;
    } finally {
      await this.glyph.dispose();
    }
  }

  private async chooseAccount(): Promise<ChatAccount> {
    const selection = await this.ui.chooseAccount(
      this.glyph.accounts,
      this.glyph.providerPresentation,
      this.shutdown,
    );
    if (selection.type === AccountSelectionType.ADD) {
      return this.glyph.signIn(undefined, false, request => this.ui.authorize(request));
    }
    return selection.account.connected
      ? selection.account
      : this.glyph.signIn(selection.account, false, request => this.ui.authorize(request));
  }

  private async enableInferenceIfNeeded(account: ChatAccount): Promise<ChatAccount> {
    if (this.glyph.hasInferenceAccess(account)) return account;
    if (!(await this.ui.confirmInferenceAccess(account.accessPrompt ?? 'Enable model access?', this.shutdown))) {
      throw new Error('Model access remains disabled. No inference was sent.');
    }
    return this.glyph.signIn(account, true, request => this.ui.authorize(request));
  }

  private async selectModel(account: ChatAccount): Promise<void> {
    if (account.notice) {
      await this.ui.acknowledgeAccountNotice(account.notice, this.shutdown);
      await this.glyph.acknowledgeAccountNotice(account);
    }
    const models = await this.glyph.listModels(account);
    const model = await this.ui.chooseModel(models, this.options.configuredModel, this.shutdown);
    this.model = model;
    const existing = this.glyph.listChats(account).find(chat => chat.modelSlug === model.slug);
    const conversation = existing
      ? this.glyph.openChat(existing.id, account)
      : await this.glyph.createChat(account, model);
    this.ui.showActive(account, model, this.glyph.providerPresentation);
    this.activateChat(conversation);
  }

  private activateChat(conversation: ChatSession): void {
    this.conversation = conversation;
    this.model = { slug: conversation.summary.modelSlug, name: conversation.summary.modelName };
    this.ui.showChatActivated(conversation.summary, conversation.transcript);
  }

  private async send(prompt: string, attachmentPaths: readonly string[]): Promise<void> {
    this.activeRequest = new AbortController();
    this.ui.beginAssistantResponse();
    try {
      const request = await this.glyph.resolveChatRequest(
        prompt,
        attachmentPaths.map(path => ({ path })),
      );
      const result = await this.requireConversation().send(request, this.ui, this.activeRequest.signal);
      this.ui.showTurnCompleted(result.durationMs, result.usage);
    } catch (error) {
      if (!this.shutdown.aborted) {
        this.ui.showTurnFailed(this.glyph.redact(describeError(error)));
      }
    } finally {
      this.activeRequest = undefined;
    }
    await this.reviewPending();
  }

  private async reviewPending(): Promise<void> {
    if (this.glyph.proposalReviews?.active && this.reviewer)
      await this.reviewer.review(this.glyph.proposalReviews, this.shutdown);
    await this.flushReviewResults();
  }

  private async flushReviewResults(): Promise<void> {
    await this.glyph.commitReviewResults(this.requireConversation());
  }

  private requireConversation(): ChatSession {
    if (!this.conversation) throw new Error('Select an account and model before sending a message.');
    return this.conversation;
  }

  private requireModel(): Model {
    if (!this.model) throw new Error('Select a model before starting a chat.');
    return this.model;
  }
}
