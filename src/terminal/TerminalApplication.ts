import type { GlyphService } from '../application/GlyphService.ts';
import type { ChatConversation } from '../chat/ChatConversation.ts';
import { describeError } from '../describeError.ts';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import { TerminalActionType } from './TerminalActionType.ts';
import type { TerminalUI } from './TerminalUI.tsx';
import type { TerminalEditReviewer } from './ui/proposal/TerminalEditReviewer.ts';

interface TerminalApplicationOptions {
  projectRoot: string;
  configuredModel?: string;
}

/**
 * Terminal host adapter. Slash commands, sequential prompts, and terminal
 * rendering live here rather than in the headless GlyphService.
 */
export class TerminalApplication {
  private activeRequest: AbortController | undefined;
  private conversation: ChatConversation | undefined;

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
      this.ui.showWelcome(this.options.projectRoot, this.glyph.tracePath, this.glyph.isTraceEnabled);

      let account = await this.enablePlanIfNeeded(await this.chooseAccount());
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
            this.requireConversation().reset();
            this.ui.showConversationReset();
            break;
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
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          case TerminalActionType.REJECT_ALL:
            try {
              await this.glyph.proposalReviews?.rejectAll();
            } catch (error) {
              this.ui.showError(this.glyph.redact(describeError(error)));
            }
            break;
          case TerminalActionType.ACCOUNT:
          case TerminalActionType.LOGIN: {
            const next =
              action.type === TerminalActionType.ACCOUNT
                ? await this.chooseAccount()
                : await this.glyph.signIn(account, !this.glyph.hasPlanAccess(account), request =>
                    this.ui.authorize(request),
                  );
            account = await this.enablePlanIfNeeded(next);
            await this.selectModel(account);
            this.ui.showConversationReplaced();
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

  private async chooseAccount(): Promise<OpenAIAccount> {
    const selection = await this.ui.chooseAccount(this.glyph.accounts, this.shutdown);
    if (selection.type === AccountSelectionType.ADD) {
      return this.glyph.signIn(undefined, false, request => this.ui.authorize(request));
    }
    return selection.account.tokens
      ? selection.account
      : this.glyph.signIn(selection.account, false, request => this.ui.authorize(request));
  }

  private async enablePlanIfNeeded(account: OpenAIAccount): Promise<OpenAIAccount> {
    if (this.glyph.hasPlanAccess(account)) return account;
    if (!(await this.ui.confirmPlanUsage(this.shutdown))) {
      throw new Error('Plan usage remains disabled. No inference was sent.');
    }
    return this.glyph.signIn(account, true, request => this.ui.authorize(request));
  }

  private async selectModel(account: OpenAIAccount): Promise<void> {
    if (!account.planNoticeSeen) {
      await this.ui.acknowledgePlanUsage(this.shutdown);
      await this.glyph.acknowledgePlanNotice(account);
    }
    const models = await this.glyph.listModels(account);
    const model = await this.ui.chooseModel(models, this.options.configuredModel, this.shutdown);
    this.conversation = this.glyph.createConversation(account, model);
    this.ui.showActive(account, model);
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
  }

  private requireConversation(): ChatConversation {
    if (!this.conversation) throw new Error('Select an account and model before sending a message.');
    return this.conversation;
  }
}
