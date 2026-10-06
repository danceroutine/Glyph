import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import type { AuthorizationRequest } from '../providers/openai/auth/AuthorizationRequest.ts';
import type { ChatResponsePart } from '../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../chat/ChatResponsePartType.ts';
import type { ChatResponseStream } from '../chat/ChatResponseStream.ts';
import type { Model } from '../chat/Model.ts';
import type { ToolActivity } from '../chat/ToolActivity.ts';
import type { Usage } from '../chat/Usage.ts';
import type { WorkspaceFileSearch } from '../context/search/WorkspaceFileSearch.ts';
import { ToolActivityPhase } from '../chat/ToolActivityPhase.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import { TerminalActionType } from './TerminalActionType.ts';
import { TerminalInput } from './TerminalInput.ts';
import { TerminalPromptComposer } from './TerminalPromptComposer.ts';
import type { UserPromptDraft } from './UserPromptDraft.ts';

const TERMINAL_HELP = `Commands: /help /reset /usage /trace [on|off] /review /accept-all /reject-all /account /login /logout /exit
Type @ at the chat prompt to fuzzy-search and attach project files.
Ctrl+C cancels a response; at a prompt it exits.
Subscription authentication only. API-key environment variables are ignored.`;

const TerminalColor = {
  USER_PROMPT: '\u001b[1;36m',
  ASSISTANT_LABEL: '\u001b[1;32m',
  ASSISTANT_TEXT: '\u001b[32m',
  THINKING: '\u001b[2;90m',
  TOOL_STARTED: '\u001b[33m',
  TOOL_COMPLETED: '\u001b[32m',
  TOOL_FAILED: '\u001b[1;31m',
  HEADING: '\u001b[1;36m',
  METADATA: '\u001b[2m',
  WARNING: '\u001b[33m',
  ERROR: '\u001b[1;31m',
  RESET: '\u001b[0m',
} as const;

type TerminalAction =
  | ({ type: TerminalActionType.SEND } & UserPromptDraft)
  | { type: TerminalActionType.EXIT }
  | { type: TerminalActionType.HELP }
  | { type: TerminalActionType.RESET }
  | { type: TerminalActionType.USAGE }
  | { type: TerminalActionType.TRACE; enabled?: boolean }
  | { type: TerminalActionType.ACCOUNT }
  | { type: TerminalActionType.LOGIN }
  | { type: TerminalActionType.LOGOUT }
  | { type: TerminalActionType.REVIEW }
  | { type: TerminalActionType.ACCEPT_ALL }
  | { type: TerminalActionType.REJECT_ALL }
  | { type: TerminalActionType.UNKNOWN_COMMAND };

type AccountSelection =
  { type: AccountSelectionType.ACCOUNT; account: OpenAIAccount } | { type: AccountSelectionType.ADD };

export class TerminalUI implements ChatResponseStream {
  static readonly help = TERMINAL_HELP;

  readonly input: TerminalInput;
  private readonly promptComposer: TerminalPromptComposer | undefined;
  private responseSection: ChatResponsePartType.TEXT | ChatResponsePartType.REASONING_SUMMARY | undefined;

  constructor(
    input: TerminalInput | NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly errorOutput: NodeJS.WritableStream = process.stderr,
    files?: WorkspaceFileSearch,
  ) {
    this.input =
      input instanceof TerminalInput
        ? input
        : new TerminalInput(input as NodeJS.ReadableStream & { resume(): void; pause(): void }, output);
    const terminalOutput = output as NodeJS.WritableStream & { isTTY?: boolean };
    this.promptComposer =
      files && this.input.isTTY && terminalOutput.isTTY === true
        ? new TerminalPromptComposer(this.input, output, files)
        : undefined;
  }

  on(event: 'SIGINT', listener: () => void): void {
    this.input.on(event, listener);
  }

  off(event: 'SIGINT', listener: () => void): void {
    this.input.off(event, listener);
  }

  onClose(listener: () => void): void {
    this.input.on('close', listener);
  }

  close(): void {
    this.input.close();
  }

  showHelp(): void {
    this.line(TERMINAL_HELP);
  }

  showWelcome(projectRoot: string, logPath: string | undefined, traceEnabled: boolean): void {
    this.line(`${this.styled('Glyph | Continue with ChatGPT', TerminalColor.HEADING)}
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
      this.line(`\n${this.styled('ChatGPT accounts', TerminalColor.HEADING)}`);
      accounts.forEach((account, index) => {
        this.line(
          `${index + 1}. ${clean(account.email)} [${clean(account.clientId)}]${account.tokens ? '' : ' (signed out)'}`,
        );
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
    this.line(
      "You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage",
    );
    await this.ask('Got it [Enter]: ', signal);
  }

  async authorize({ url }: AuthorizationRequest): Promise<void> {
    this.line(
      `\n${this.styled('Continue with ChatGPT', TerminalColor.HEADING)}\nAuthorize Glyph to use your ChatGPT plan.\n`,
    );
    this.line(`If the browser does not open, visit:\n${clean(url)}\n`);

    if (process.platform === 'win32') return;
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }

  async nextAction(signal: AbortSignal): Promise<TerminalAction> {
    const draft = this.promptComposer
      ? await this.promptComposer.compose(this.styled('you> ', TerminalColor.USER_PROMPT), signal)
      : {
          prompt: (await this.ask(this.styled('you> ', TerminalColor.USER_PROMPT), signal)).trim(),
          attachmentPaths: [],
        };
    const input = draft.prompt.trim();
    switch (input) {
      case '':
        return this.nextAction(signal);
      case '/exit':
      case '/quit':
        return { type: TerminalActionType.EXIT };
      case '/help':
        return { type: TerminalActionType.HELP };
      case '/reset':
        return { type: TerminalActionType.RESET };
      case '/usage':
        return { type: TerminalActionType.USAGE };
      case '/trace':
        return { type: TerminalActionType.TRACE };
      case '/trace on':
        return { type: TerminalActionType.TRACE, enabled: true };
      case '/trace off':
        return { type: TerminalActionType.TRACE, enabled: false };
      case '/account':
        return { type: TerminalActionType.ACCOUNT };
      case '/login':
        return { type: TerminalActionType.LOGIN };
      case '/logout':
        return { type: TerminalActionType.LOGOUT };
      case '/review':
        return { type: TerminalActionType.REVIEW };
      case '/accept-all':
        return { type: TerminalActionType.ACCEPT_ALL };
      case '/reject-all':
        return { type: TerminalActionType.REJECT_ALL };
      default:
        return input.startsWith('/')
          ? { type: TerminalActionType.UNKNOWN_COMMAND }
          : { type: TerminalActionType.SEND, prompt: input, attachmentPaths: draft.attachmentPaths };
    }
  }

  beginAssistantResponse(): void {
    this.responseSection = undefined;
  }

  push(part: ChatResponsePart): void {
    if (part.type === ChatResponsePartType.TEXT) {
      this.openResponseSection(ChatResponsePartType.TEXT, 'assistant> ');
      this.output.write(this.styled(clean(part.value), TerminalColor.ASSISTANT_TEXT));
      return;
    }
    if (part.type === ChatResponsePartType.REASONING_SUMMARY) {
      this.openResponseSection(ChatResponsePartType.REASONING_SUMMARY, 'thinking> ');
      this.output.write(this.styled(clean(part.value), TerminalColor.THINKING));
      return;
    }
    if (part.type === ChatResponsePartType.DIAGNOSTIC) {
      this.responseSection = undefined;
      this.errorLine(clean(part.message));
      return;
    }
    this.writeToolActivity(part.activity);
    this.responseSection = undefined;
  }

  showTurnCompleted(durationMs: number, usage: Usage | null): void {
    const summary = `[${(durationMs / 1000).toFixed(1)}s | ${usage ? formatUsage(usage) : 'usage unavailable'}]`;
    this.line(`\n${this.styled(summary, TerminalColor.METADATA)}\n`);
    this.responseSection = undefined;
  }

  showTurnFailed(message: string): void {
    this.errorLine(`\n${clean(message)}\nThis turn was not added to history.\n`);
    this.responseSection = undefined;
  }

  showActive(account: OpenAIAccount, model: Model): void {
    this.line(`\n${this.styled('Active', TerminalColor.HEADING)}  ${clean(account.email)} [${clean(account.clientId)}]
${this.styled('Model', TerminalColor.HEADING)}   ${clean(model.slug)}  ${this.styled('ChatGPT plan', TerminalColor.METADATA)}\n`);
  }

  showConversationReset(): void {
    this.line('Conversation cleared.');
  }
  showConversationReplaced(): void {
    this.line('Started a new conversation for the selected account.');
  }
  showUnknownCommand(): void {
    this.line(this.styled('Unknown command. Use /help.', TerminalColor.WARNING));
  }

  showUsage(usage: Usage): void {
    this.line(`${formatUsage(usage)}\nCompleted requests only. Plan/credit limits: https://chatgpt.com/settings/usage`);
  }

  showTrace(enabled: boolean, path: string | undefined): void {
    const message = enabled
      ? `Full provider tracing is on: ${path ? clean(path) : 'logger destination unavailable'}`
      : 'Full provider tracing is off.';
    this.line(this.styled(message, TerminalColor.METADATA));
  }

  showLogout(revoked: boolean): void {
    this.line(
      revoked
        ? 'Signed out. Renewable session revoked.'
        : 'Local tokens cleared. Remote revocation was not confirmed; disconnect Glyph in ChatGPT settings.',
    );
  }

  showError(message: string): void {
    this.errorLine(clean(message));
  }

  private async ask(prompt: string, signal: AbortSignal): Promise<string> {
    return this.input.question(prompt, signal);
  }

  private line(value: string): void {
    this.output.write(`${value}\n`);
  }

  private errorLine(value: string): void {
    this.errorOutput.write(`${this.styled(value, TerminalColor.ERROR, this.errorOutput)}\n`);
  }

  private openResponseSection(
    section: ChatResponsePartType.TEXT | ChatResponsePartType.REASONING_SUMMARY,
    label: string,
  ): void {
    if (this.responseSection === section) return;
    if (this.responseSection !== undefined) this.output.write('\n\n');
    const color =
      section === ChatResponsePartType.REASONING_SUMMARY ? TerminalColor.THINKING : TerminalColor.ASSISTANT_LABEL;
    this.output.write(this.styled(label, color));
    this.responseSection = section;
  }

  private writeToolActivity(activity: ToolActivity): void {
    const prefix = this.responseSection === undefined ? '' : '\n\n';
    const name = activity.namespace ? `${activity.namespace}.${activity.name}` : activity.name;
    if (activity.phase === ToolActivityPhase.STARTED) {
      const label = this.styled(clean(`[tool> ${name}]`), TerminalColor.TOOL_STARTED);
      const argumentsText = clean(activity.arguments).trimEnd();
      const details = argumentsText.includes('\n')
        ? `\n${this.styled(indent(argumentsText), TerminalColor.METADATA)}`
        : argumentsText
          ? ` ${this.styled(argumentsText, TerminalColor.METADATA)}`
          : '';
      this.output.write(`${prefix}${label}${details}\n`);
      return;
    }
    const result = formatToolResult(activity);
    const color = result.failed ? TerminalColor.TOOL_FAILED : TerminalColor.TOOL_COMPLETED;
    this.output.write(`${prefix}${this.styled(clean(`[tool< ${name} ${result.message}]`), color)}\n`);
  }

  private styled(value: string, color: string, destination: NodeJS.WritableStream = this.output): string {
    const terminal = destination as NodeJS.WritableStream & { isTTY?: boolean };
    return terminal.isTTY === true && process.env.NO_COLOR === undefined
      ? `${color}${value}${TerminalColor.RESET}`
      : value;
  }
}

function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

function formatUsage(usage: Usage): string {
  return `input ${usage.inputTokens} (cached ${usage.cachedInputTokens}) | output ${usage.outputTokens} (reasoning ${usage.reasoningTokens}) | total ${usage.totalTokens}`;
}

function formatToolResult(activity: ToolActivity): { message: string; failed: boolean } {
  try {
    const result: unknown = JSON.parse(activity.output ?? '');
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return { message: `error: ${formatToolError((result as { error: unknown }).error)}`, failed: true };
    }
  } catch {
    /* Non-JSON output is still a successful tool result. */
  }
  return { message: 'completed', failed: false };
}

function indent(value: string): string {
  return value
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function formatToolError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return formatToolErrorValue(error);
  const details = error as Record<string, unknown>;
  const code = typeof details.code === 'string' ? details.code : undefined;
  const message = typeof details.message === 'string' ? details.message : undefined;
  const context = Object.entries(details)
    .filter(([key]) => key !== 'code' && key !== 'message')
    .map(([key, value]) => `${key}=${formatToolErrorValue(value)}`);
  const description = [code, message].filter(Boolean).join(': ') || formatToolErrorValue(error);
  return context.length > 0 ? `${description} (${context.join('; ')})` : description;
}

function formatToolErrorValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatToolErrorValue).join(', ');
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return 'Unprintable error details';
  }
}
