import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import type { AuthorizationRequest } from '../providers/openai/auth/AuthorizationRequest.ts';
import type { ChatResponsePart } from '../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../chat/ChatResponsePartType.ts';
import type { ChatResponseStream } from '../chat/ChatResponseStream.ts';
import type { Model } from '../chat/Model.ts';
import type { ToolActivity } from '../chat/ToolActivity.ts';
import type { Usage } from '../chat/Usage.ts';
import { ToolActivityPhase } from '../chat/ToolActivityPhase.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import { TerminalActionType } from './TerminalActionType.ts';

const TERMINAL_HELP = `Commands: /help /reset /usage /trace [on|off] /account /login /logout /exit
Ctrl+C cancels a response; at a prompt it exits.
Subscription authentication only. API-key environment variables are ignored.`;

type TerminalAction =
  | { type: TerminalActionType.SEND; prompt: string }
  | { type: TerminalActionType.EXIT }
  | { type: TerminalActionType.HELP }
  | { type: TerminalActionType.RESET }
  | { type: TerminalActionType.USAGE }
  | { type: TerminalActionType.TRACE; enabled?: boolean }
  | { type: TerminalActionType.ACCOUNT }
  | { type: TerminalActionType.LOGIN }
  | { type: TerminalActionType.LOGOUT }
  | { type: TerminalActionType.UNKNOWN_COMMAND };

type AccountSelection =
  | { type: AccountSelectionType.ACCOUNT; account: OpenAIAccount }
  | { type: AccountSelectionType.ADD };

export class TerminalUI implements ChatResponseStream {
  static readonly help = TERMINAL_HELP;

  private readonly reader: Interface;
  private closed = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly errorOutput: NodeJS.WritableStream = process.stderr,
  ) {
    this.reader = createInterface({ input, output });
    this.reader.on('close', () => { this.closed = true; });
  }

  on(event: 'SIGINT', listener: () => void): void {
    this.reader.on(event, listener);
  }

  off(event: 'SIGINT', listener: () => void): void {
    this.reader.off(event, listener);
  }

  onClose(listener: () => void): void {
    this.reader.on('close', listener);
  }

  close(): void {
    if (!this.closed) this.reader.close();
  }

  showHelp(): void {
    this.line(TERMINAL_HELP);
  }

  showWelcome(projectRoot: string, logPath: string | undefined, traceEnabled: boolean): void {
    this.line(`Harness Chat | Continue with ChatGPT
Project: ${clean(projectRoot)}
Uses your plan allowance and any credits you authorize in ChatGPT settings.
Usage controls: https://chatgpt.com/settings/usage
Log: ${logPath ? clean(logPath) : 'off'}
Full provider tracing: ${traceEnabled ? 'on' : 'off'}
${TERMINAL_HELP}`);
  }

  static clean(text: string): string {
    return clean(text);
  }

  async chooseAccount(accounts: readonly OpenAIAccount[], signal: AbortSignal): Promise<AccountSelection> {
    for (;;) {
      this.line('\nChatGPT accounts:');
      accounts.forEach((account, index) => {
        this.line(`${index + 1}. ${clean(account.email)} [${clean(account.clientId)}]${account.tokens ? '' : ' (signed out)'}`);
      });
      this.line('a. Add another account/workspace');
      const onlyAccount = accounts.length === 1 ? '1' : undefined;
      const prompt = onlyAccount ? 'Account number [1], or a to add: ' : 'Account number, or a to add: ';
      const answer = (await this.ask(prompt, signal)).trim().toLowerCase();
      const choice = answer || onlyAccount;
      if (choice === 'a') return { type: AccountSelectionType.ADD };
      const account = accounts[Number(choice) - 1];
      if (choice && account && /^\d+$/.test(choice)) return { type: AccountSelectionType.ACCOUNT, account };
      this.line('Choose an account number or a to add one.');
    }
  }

  async chooseModel(models: readonly Model[], configured: string | undefined, signal: AbortSignal): Promise<Model> {
    models.forEach((model, index) => this.line(`${index + 1}. ${clean(model.name)} (${clean(model.slug)})`));
    let model = configured ? models.find(candidate => candidate.slug === configured) : undefined;
    if (configured && !model) this.line('CHAT_MODEL is not in this account catalog. Choose an available model.');
    while (!model) {
      const choice = (await this.ask('Model number: ', signal)).trim();
      if (/^\d+$/.test(choice)) model = models[Number(choice) - 1];
    }
    return model;
  }

  async confirmPlanUsage(signal: AbortSignal): Promise<boolean> {
    return (await this.ask('Enable ChatGPT plan usage for this account? [y/N]: ', signal)).trim().toLowerCase() === 'y';
  }

  async acknowledgePlanUsage(signal: AbortSignal): Promise<void> {
    this.line("You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage");
    await this.ask('Got it [Enter]: ', signal);
  }

  async authorize({ url }: AuthorizationRequest): Promise<void> {
    this.line('\nContinue with ChatGPT\nAuthorize Harness Chat to use your ChatGPT plan.\n');
    this.line(`If the browser does not open, visit:\n${clean(url)}\n`);

    if (process.platform === 'win32') return;
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }

  async nextAction(signal: AbortSignal): Promise<TerminalAction> {
    const input = (await this.ask('you> ', signal)).trim();
    switch (input) {
      case '': return this.nextAction(signal);
      case '/exit':
      case '/quit': return { type: TerminalActionType.EXIT };
      case '/help': return { type: TerminalActionType.HELP };
      case '/reset': return { type: TerminalActionType.RESET };
      case '/usage': return { type: TerminalActionType.USAGE };
      case '/trace': return { type: TerminalActionType.TRACE };
      case '/trace on': return { type: TerminalActionType.TRACE, enabled: true };
      case '/trace off': return { type: TerminalActionType.TRACE, enabled: false };
      case '/account': return { type: TerminalActionType.ACCOUNT };
      case '/login': return { type: TerminalActionType.LOGIN };
      case '/logout': return { type: TerminalActionType.LOGOUT };
      default: return input.startsWith('/')
        ? { type: TerminalActionType.UNKNOWN_COMMAND }
        : { type: TerminalActionType.SEND, prompt: input };
    }
  }

  beginAssistantResponse(): void {
    this.output.write('assistant> ');
  }

  push(part: ChatResponsePart): void {
    if (part.type === ChatResponsePartType.TEXT) {
      this.output.write(clean(part.value));
      return;
    }
    if (part.type === ChatResponsePartType.DIAGNOSTIC) {
      this.errorLine(clean(part.message));
      return;
    }
    this.output.write(`\n${clean(formatToolActivity(part.activity))}\n`);
  }

  showTurnCompleted(durationMs: number, usage: Usage | null): void {
    this.line(`\n[${(durationMs / 1000).toFixed(1)}s | ${usage ? formatUsage(usage) : 'usage unavailable'}]\n`);
  }

  showTurnFailed(message: string): void {
    this.errorLine(`\n${clean(message)}\nThis turn was not added to history.\n`);
  }

  showActive(account: OpenAIAccount, model: Model): void {
    this.line(`\nActive: ${clean(account.email)} [${clean(account.clientId)}]\nModel: ${clean(model.slug)} | Billing: ChatGPT plan\n`);
  }

  showConversationReset(): void { this.line('Conversation cleared.'); }
  showConversationReplaced(): void { this.line('Started a new conversation for the selected account.'); }
  showUnknownCommand(): void { this.line('Unknown command. Use /help.'); }

  showUsage(usage: Usage): void {
    this.line(`${formatUsage(usage)}\nCompleted requests only. Plan/credit limits: https://chatgpt.com/settings/usage`);
  }

  showTrace(enabled: boolean, path: string | undefined): void {
    this.line(enabled ? `Full provider tracing is on: ${path ? clean(path) : 'logger destination unavailable'}` : 'Full provider tracing is off.');
  }

  showLogout(revoked: boolean): void {
    this.line(revoked
      ? 'Signed out. Renewable session revoked.'
      : 'Local tokens cleared. Remote revocation was not confirmed; disconnect Harness Chat in ChatGPT settings.');
  }

  showError(message: string): void {
    this.errorLine(clean(message));
  }

  private async ask(prompt: string, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error('Session closed.');
    return this.reader.question(prompt, { signal });
  }

  private line(value: string): void {
    this.output.write(`${value}\n`);
  }

  private errorLine(value: string): void {
    this.errorOutput.write(`${value}\n`);
  }
}

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function formatUsage(usage: Usage): string {
  return `input ${usage.inputTokens} (cached ${usage.cachedInputTokens}) | output ${usage.outputTokens} (reasoning ${usage.reasoningTokens}) | total ${usage.totalTokens}`;
}

function formatToolActivity(activity: ToolActivity): string {
  const name = activity.namespace ? `${activity.namespace}.${activity.name}` : activity.name;
  if (activity.phase === ToolActivityPhase.STARTED) return `[tool> ${name} ${activity.arguments}]`;
  try {
    const result: unknown = JSON.parse(activity.output ?? '');
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return `[tool< ${name} error: ${String((result as { error: unknown }).error)}]`;
    }
  } catch { /* Non-JSON output is still a successful tool result. */ }
  return `[tool< ${name} completed]`;
}
