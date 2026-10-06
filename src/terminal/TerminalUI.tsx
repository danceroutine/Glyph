import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline/promises';
import type { Interface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import { Box, Text } from 'ink';
import type { OpenAIAccount } from '../providers/openai/auth/OpenAIAccount.ts';
import type { AuthorizationRequest } from '../providers/openai/auth/AuthorizationRequest.ts';
import type { ChatResponsePart } from '../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../chat/ChatResponsePartType.ts';
import type { ChatResponseStream } from '../chat/ChatResponseStream.ts';
import type { Model } from '../chat/Model.ts';
import type { ToolActivity } from '../chat/ToolActivity.ts';
import type { Usage } from '../chat/Usage.ts';
import type { WorkspacePathIndex } from '../context/search/WorkspacePathIndex.ts';
import { ToolActivityPhase } from '../chat/ToolActivityPhase.ts';
import type { ProposalReviewManager } from '../editing/reviews/ProposalReviewManager.ts';
import { AccountSelectionType } from './AccountSelectionType.ts';
import {
  mergeReviewEntries,
  pendingReviewEntries,
  renderEntry,
  ReviewViewMode,
} from './ui/proposal/TerminalEditReviewer.ts';
import { TerminalActionType } from './TerminalActionType.ts';
import { resolveTerminalCommand, TERMINAL_COMMANDS, type TerminalCommandAction } from './TerminalCommand.ts';
import { TerminalInkRenderer } from './ui/runtime/TerminalInkRenderer.tsx';
import type { TerminalInputStream } from './ui/runtime/TerminalInputStream.ts';
import type { TerminalOutputStream } from './ui/runtime/TerminalOutputStream.ts';
import type { UserPromptDraft } from './ui/prompt/UserPromptDraft.ts';
import { inlineMarkdownText } from './ui/response/parseInlineMarkdown.ts';
import { sanitizeText } from './ui/shared/sanitizeText.ts';

const TERMINAL_HELP = `Commands: ${TERMINAL_COMMANDS.map(command => command.value).join(' ')}
Type @ at the chat prompt to fuzzy-search and attach project files.
Type / at the chat prompt to search commands.
Ctrl+C cancels a response; at a prompt it exits.
Subscription authentication only. API-key environment variables are ignored.`;

type TerminalAction =
  | ({ type: TerminalActionType.SEND } & UserPromptDraft)
  | TerminalCommandAction
  | { type: TerminalActionType.UNKNOWN_COMMAND };

type AccountSelection =
  { type: AccountSelectionType.ACCOUNT; account: OpenAIAccount } | { type: AccountSelectionType.ADD };

/** Ink-backed terminal host with a plain readline fallback for redirected IO. */
export class TerminalUI implements ChatResponseStream {
  static readonly help = TERMINAL_HELP;

  private readonly events = new EventEmitter();
  private readonly renderer: TerminalInkRenderer | undefined;
  private reader: Interface | undefined;
  private closed = false;
  private responseSection: ChatResponsePartType.TEXT | ChatResponsePartType.REASONING_SUMMARY | undefined;

  constructor(
    private readonly input: TerminalInputStream = process.stdin,
    private readonly output: TerminalOutputStream = process.stdout,
    private readonly errorOutput: NodeJS.WritableStream = process.stderr,
    private readonly files?: WorkspacePathIndex,
  ) {
    if (input.isTTY === true && typeof input.setRawMode === 'function' && output.isTTY === true) {
      this.renderer = new TerminalInkRenderer(input, output, errorOutput);
      this.renderer.on('SIGINT', () => this.events.emit('SIGINT'));
      this.renderer.on('close', () => this.events.emit('close'));
    } else {
      input.once('end', this.handleInputClosed);
      input.once('close', this.handleInputClosed);
    }
  }

  on(event: 'SIGINT', listener: () => void): void {
    this.events.on(event, listener);
  }
  off(event: 'SIGINT', listener: () => void): void {
    this.events.off(event, listener);
  }
  onClose(listener: () => void): void {
    this.events.on('close', listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.off('end', this.handleInputClosed);
    this.input.off('close', this.handleInputClosed);
    this.reader?.close();
    this.reader = undefined;
    this.renderer?.close();
  }

  showHelp(): void {
    this.appendText(TERMINAL_HELP);
  }

  showWelcome(projectRoot: string, logPath: string | undefined, traceEnabled: boolean): void {
    if (this.renderer) {
      this.renderer.append(
        <Box flexDirection="column">
          <Text bold color="cyan">
            Glyph | Continue with ChatGPT
          </Text>
          <Text>{`Project: ${clean(projectRoot)}`}</Text>
          <Text>Uses your plan allowance and any credits you authorize in ChatGPT settings.</Text>
          <Text dimColor>Usage controls: https://chatgpt.com/settings/usage</Text>
          <Text dimColor>{`Log: ${logPath ? clean(logPath) : 'off'}`}</Text>
          <Text dimColor>{`Full provider tracing: ${traceEnabled ? 'on' : 'off'}`}</Text>
          <Text>{TERMINAL_HELP}</Text>
        </Box>,
      );
      return;
    }
    this.line(`Glyph | Continue with ChatGPT
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
      if (this.renderer) {
        this.renderer.append(
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="cyan">
              ChatGPT accounts
            </Text>
            {accounts.map((account, index) => (
              <Text key={account.subject}>
                {`${index + 1}. ${clean(account.email)} [${clean(account.clientId)}]${account.tokens ? '' : ' (signed out)'}`}
              </Text>
            ))}
            <Text>a. Add another account/workspace</Text>
          </Box>,
        );
      } else {
        this.line('\nChatGPT accounts');
        accounts.forEach((account, index) => {
          this.line(
            `${index + 1}. ${clean(account.email)} [${clean(account.clientId)}]${account.tokens ? '' : ' (signed out)'}`,
          );
        });
        this.line('a. Add another account/workspace');
      }
      const onlyAccount = accounts.length === 1 ? '1' : undefined;
      const label = onlyAccount ? 'Account number [1], or a to add: ' : 'Account number, or a to add: ';
      const answer = (await this.ask(label, signal)).trim().toLowerCase();
      const choice = answer || onlyAccount;
      if (choice === 'a') return { type: AccountSelectionType.ADD };
      const account = accounts[Number(choice) - 1];
      if (choice && account && /^\d+$/.test(choice)) return { type: AccountSelectionType.ACCOUNT, account };
      this.appendText('Choose an account number or a to add one.', { color: 'yellow' });
    }
  }

  async chooseModel(models: readonly Model[], configured: string | undefined, signal: AbortSignal): Promise<Model> {
    if (this.renderer) {
      this.renderer.append(
        <Box flexDirection="column">
          <Text bold color="cyan">
            Available models
          </Text>
          {models.map((model, index) => (
            <Text key={model.slug}>{`${index + 1}. ${clean(model.name)} (${clean(model.slug)})`}</Text>
          ))}
        </Box>,
      );
    } else models.forEach((model, index) => this.line(`${index + 1}. ${clean(model.name)} (${clean(model.slug)})`));
    let model = configured ? models.find(candidate => candidate.slug === configured) : undefined;
    if (configured && !model)
      this.appendText('CHAT_MODEL is not in this account catalog. Choose an available model.', { color: 'yellow' });
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
    this.appendText(
      "You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage",
    );
    await this.ask('Got it [Enter]: ', signal);
  }

  async authorize({ url }: AuthorizationRequest): Promise<void> {
    if (this.renderer) {
      this.renderer.append(
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            Continue with ChatGPT
          </Text>
          <Text>Authorize Glyph to use your ChatGPT plan.</Text>
          <Text>If the browser does not open, visit:</Text>
          <Text underline>{clean(url)}</Text>
        </Box>,
      );
    } else
      this.line(
        `\nContinue with ChatGPT\nAuthorize Glyph to use your ChatGPT plan.\n\nIf the browser does not open, visit:\n${clean(url)}\n`,
      );

    if (process.platform === 'win32') return;
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }

  async nextAction(signal: AbortSignal, pendingChanges = 0): Promise<TerminalAction> {
    const draft = this.renderer
      ? await this.renderer.prompt('you> ', signal, this.files, pendingChanges)
      : { prompt: (await this.ask('you> ', signal)).trim(), attachmentPaths: [] };
    const input = draft.prompt.trim();
    if (input === '') return this.nextAction(signal, pendingChanges);
    const command = resolveTerminalCommand(input);
    if (command) return command;
    return input.startsWith('/')
      ? { type: TerminalActionType.UNKNOWN_COMMAND }
      : { type: TerminalActionType.SEND, prompt: input, attachmentPaths: draft.attachmentPaths };
  }

  beginAssistantResponse(): void {
    this.responseSection = undefined;
    this.renderer?.beginResponse();
  }

  push(part: ChatResponsePart): void {
    if (this.renderer) {
      this.renderer.pushResponse(part);
      return;
    }
    if (part.type === ChatResponsePartType.TEXT) {
      this.openResponseSection(ChatResponsePartType.TEXT, 'assistant> ');
      this.output.write(clean(part.value));
      return;
    }
    if (part.type === ChatResponsePartType.REASONING_SUMMARY) {
      this.openResponseSection(ChatResponsePartType.REASONING_SUMMARY, 'thinking> ');
      this.output.write(clean(inlineMarkdownText(part.value)));
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
    if (this.renderer) this.renderer.completeResponse(<Text dimColor>{summary}</Text>);
    else this.line(`\n${summary}\n`);
    this.responseSection = undefined;
  }

  showTurnFailed(message: string): void {
    if (this.renderer) {
      this.renderer.completeResponse(
        <Box flexDirection="column">
          <Text bold color="red">
            {clean(message)}
          </Text>
          <Text dimColor>This turn was not added to history.</Text>
        </Box>,
      );
    } else this.errorLine(`\n${clean(message)}\nThis turn was not added to history.\n`);
    this.responseSection = undefined;
  }

  showActive(account: OpenAIAccount, model: Model): void {
    if (this.renderer) {
      this.renderer.append(
        <Box flexDirection="column" marginY={1}>
          <Text>
            <Text bold color="cyan">
              {'Active  '}
            </Text>
            {`${clean(account.email)} [${clean(account.clientId)}]`}
          </Text>
          <Text>
            <Text bold color="cyan">
              {'Model   '}
            </Text>
            {`${clean(model.slug)}  `}
            <Text dimColor>ChatGPT plan</Text>
          </Text>
        </Box>,
      );
    } else
      this.line(
        `\nActive  ${clean(account.email)} [${clean(account.clientId)}]\nModel   ${clean(model.slug)}  ChatGPT plan\n`,
      );
  }

  showConversationReset(): void {
    this.appendText('Conversation cleared.');
  }
  showConversationReplaced(): void {
    this.appendText('Started a new conversation for the selected account.');
  }
  showUnknownCommand(): void {
    this.appendText('Unknown command. Use /help.', { color: 'yellow' });
  }

  showUsage(usage: Usage): void {
    this.appendText(
      `${formatUsage(usage)}\nCompleted requests only. Plan/credit limits: https://chatgpt.com/settings/usage`,
    );
  }

  showTrace(enabled: boolean, path: string | undefined): void {
    this.appendText(
      enabled
        ? `Full provider tracing is on: ${path ? clean(path) : 'logger destination unavailable'}`
        : 'Full provider tracing is off.',
      { dimColor: true },
    );
  }

  showLogout(revoked: boolean): void {
    this.appendText(
      revoked
        ? 'Signed out. Renewable session revoked.'
        : 'Local tokens cleared. Remote revocation was not confirmed; disconnect Glyph in ChatGPT settings.',
    );
  }

  showError(message: string): void {
    this.appendText(clean(message), { bold: true, color: 'red' });
  }

  async reviewProposals(manager: ProposalReviewManager, signal: AbortSignal, onInterrupt: () => void): Promise<void> {
    if (manager.activeReviews.length === 0) return;
    if (this.renderer) return this.renderer.review(manager, signal, onInterrupt);
    let queue = mergeReviewEntries([], manager.activeReviews);
    while (manager.activeReviews.length > 0) {
      queue = mergeReviewEntries(queue, manager.activeReviews);
      const entry = pendingReviewEntries(queue)[0];
      if (!entry) return;
      this.line(renderEntry(entry.file, entry.item, ReviewViewMode.FOCUSED, false).lines.join('\n'));
      const answer = (await this.ask('Accept? [y/n/q]: ', signal)).trim().toLowerCase();
      if (answer === 'q') return;
      try {
        if (answer === 'y') await manager.acceptInReview(entry.review.id, entry.item.id);
        else if (answer === 'n') await manager.rejectInReview(entry.review.id, entry.item.id);
      } catch (error) {
        this.errorLine(`Error: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
      }
    }
  }

  private async ask(label: string, signal: AbortSignal): Promise<string> {
    if (this.closed) throw new Error('Session closed.');
    if (this.renderer) return (await this.renderer.prompt(label, signal)).prompt;
    return this.getReader().question(label, { signal });
  }

  private getReader(): Interface {
    if (this.reader) return this.reader;
    const reader = createInterface({ input: this.input, output: this.output });
    this.reader = reader;
    reader.on('SIGINT', this.forwardInterrupt);
    reader.once('close', () => {
      reader.off('SIGINT', this.forwardInterrupt);
      if (this.reader !== reader) return;
      this.reader = undefined;
      this.events.emit('close');
    });
    return reader;
  }

  private appendText(text: string, style: { bold?: boolean; color?: 'red' | 'yellow'; dimColor?: boolean } = {}): void {
    if (this.renderer) this.renderer.append(<Text {...style}>{clean(text)}</Text>);
    else this.line(clean(text));
  }

  private line(value: string): void {
    this.output.write(`${value}\n`);
  }
  private errorLine(value: string): void {
    this.errorOutput.write(`${value}\n`);
  }

  private openResponseSection(
    section: ChatResponsePartType.TEXT | ChatResponsePartType.REASONING_SUMMARY,
    label: string,
  ): void {
    if (this.responseSection === section) return;
    if (this.responseSection !== undefined) this.output.write('\n\n');
    this.output.write(label);
    this.responseSection = section;
  }

  private writeToolActivity(activity: ToolActivity): void {
    const prefix = this.responseSection === undefined ? '' : '\n\n';
    const name = activity.namespace ? `${activity.namespace}.${activity.name}` : activity.name;
    if (activity.phase === ToolActivityPhase.STARTED) {
      this.output.write(`${prefix}[${name} …]\n`);
      return;
    }
    const result = formatToolResult(activity);
    if (!result.failed) {
      this.output.write(`${prefix}[${name} ✓]\n`);
      return;
    }
    const argumentsText = clean(activity.arguments).trimEnd();
    const details = argumentsText ? `\n${indent(argumentsText)}` : '';
    this.output.write(`${prefix}[${name} ×]${details}\n  ${result.message}\n`);
  }

  private readonly forwardInterrupt = (): void => {
    this.events.emit('SIGINT');
  };
  private readonly handleInputClosed = (): void => {
    this.events.emit('close');
  };
}

function clean(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(
      /[\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

function formatUsage(usage: Usage): string {
  return `input ${usage.inputTokens} (cached ${usage.cachedInputTokens}) | output ${usage.outputTokens} (reasoning ${usage.reasoningTokens}) | total ${usage.totalTokens}`;
}

function formatToolResult(activity: ToolActivity): { message: string; failed: boolean } {
  try {
    const result: unknown = JSON.parse(activity.output ?? '');
    if (typeof result === 'object' && result !== null && 'error' in result) {
      return { message: `Error: ${formatToolError((result as { error: unknown }).error)}`, failed: true };
    }
  } catch {
    // Non-JSON output is still a successful tool result.
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
