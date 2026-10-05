import type { HarnessService } from '../application/HarnessService.ts';
import type { ChatConversation } from '../chat/ChatConversation.ts';
import { describeError } from '../describeError.ts';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import { TerminalActionType } from './TerminalActionType.ts';
import type { TerminalUI } from './TerminalUI.ts';
import type { TerminalEditReviewer } from './TerminalEditReviewer.ts';

interface TerminalApplicationOptions {
  projectRoot: string;
  configuredModel?: string;
}

/**
 * Terminal host adapter. Slash commands, sequential prompts, and terminal
 * rendering live here rather than in the headless HarnessService.
 */
export class TerminalApplication {
  private activeRequest: AbortController | undefined;
  private conversation: ChatConversation | undefined;

  constructor(
    private readonly harness: HarnessService,
    private readonly ui: TerminalUI,
    private readonly shutdown: AbortSignal,
    private readonly options: TerminalApplicationOptions,
    private readonly reviewer?: TerminalEditReviewer,
  ) {}

  get active(): AbortController | undefined { return this.activeRequest; }

  async run(): Promise<number> {
    try {
      await this.harness.initialize();
      if (this.shutdown.aborted) return 0;
      this.ui.showWelcome(
        this.options.projectRoot,
        this.harness.tracePath,
        this.harness.isTraceEnabled,
      );

      let account = await this.enablePlanIfNeeded(await this.chooseAccount());
      await this.selectModel(account);
      await this.reviewPending();

      while (!this.shutdown.aborted) {
        const action = await this.ui.nextAction(this.shutdown);
        switch (action.type) {
          case TerminalActionType.EXIT: return 0;
          case TerminalActionType.HELP: this.ui.showHelp(); break;
          case TerminalActionType.RESET:
            this.requireConversation().reset();
            this.ui.showConversationReset();
            break;
          case TerminalActionType.USAGE:
            this.ui.showUsage(this.harness.usage);
            break;
          case TerminalActionType.TRACE: {
            const enabled = action.enabled ?? this.harness.isTraceEnabled;
            this.harness.setTraceEnabled(enabled);
            this.requireConversation().setTraceEnabled(enabled);
            this.ui.showTrace(enabled, this.harness.tracePath);
            break;
          }
          case TerminalActionType.LOGOUT:
            this.ui.showLogout(await this.harness.logout(account));
            return 0;
          case TerminalActionType.REVIEW:
            await this.reviewPending();
            break;
          case TerminalActionType.ACCEPT_ALL:
            try { await this.harness.edits?.acceptAll(); }
            catch (error) { this.ui.showError(this.harness.redact(describeError(error))); }
            break;
          case TerminalActionType.REJECT_ALL:
            try { await this.harness.edits?.rejectAll(); }
            catch (error) { this.ui.showError(this.harness.redact(describeError(error))); }
            break;
          case TerminalActionType.ACCOUNT:
          case TerminalActionType.LOGIN: {
            const next = action.type === TerminalActionType.ACCOUNT
              ? await this.chooseAccount()
              : await this.harness.signIn(
                account,
                !this.harness.hasPlanAccess(account),
                request => this.ui.authorize(request),
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
            await this.send(action.prompt);
            break;
        }
      }
      return 0;
    } catch (error) {
      if (!this.shutdown.aborted) this.ui.showError(this.harness.redact(describeError(error)));
      return this.shutdown.aborted ? 0 : 1;
    } finally {
      await this.harness.dispose();
    }
  }

  private async chooseAccount(): Promise<OpenAIAccount> {
    const selection = await this.ui.chooseAccount(this.harness.accounts, this.shutdown);
    if (selection.type === AccountSelectionType.ADD) {
      return this.harness.signIn(undefined, false, request => this.ui.authorize(request));
    }
    return selection.account.tokens
      ? selection.account
      : this.harness.signIn(selection.account, false, request => this.ui.authorize(request));
  }

  private async enablePlanIfNeeded(account: OpenAIAccount): Promise<OpenAIAccount> {
    if (this.harness.hasPlanAccess(account)) return account;
    if (!await this.ui.confirmPlanUsage(this.shutdown)) {
      throw new Error('Plan usage remains disabled. No inference was sent.');
    }
    return this.harness.signIn(account, true, request => this.ui.authorize(request));
  }

  private async selectModel(account: OpenAIAccount): Promise<void> {
    if (!account.planNoticeSeen) {
      await this.ui.acknowledgePlanUsage(this.shutdown);
      await this.harness.acknowledgePlanNotice(account);
    }
    const models = await this.harness.listModels(account);
    const model = await this.ui.chooseModel(models, this.options.configuredModel, this.shutdown);
    this.conversation = this.harness.createConversation(account, model);
    this.ui.showActive(account, model);
  }

  private async send(prompt: string): Promise<void> {
    this.activeRequest = new AbortController();
    this.ui.beginAssistantResponse();
    try {
      const result = await this.requireConversation().send(prompt, this.ui, this.activeRequest.signal);
      this.ui.showTurnCompleted(result.durationMs, result.usage);
    } catch (error) {
      if (!this.shutdown.aborted) {
        this.ui.showTurnFailed(this.harness.redact(describeError(error)));
      }
    } finally {
      this.activeRequest = undefined;
    }
    await this.reviewPending();
  }

  private async reviewPending(): Promise<void> {
    if (this.harness.edits?.active && this.reviewer) await this.reviewer.review(this.harness.edits, this.shutdown);
  }

  private requireConversation(): ChatConversation {
    if (!this.conversation) throw new Error('Select an account and model before sending a message.');
    return this.conversation;
  }
}
