import { TerminalActionType } from './TerminalActionType.ts';

export type TerminalCommandAction =
  | { readonly type: TerminalActionType.EXIT }
  | { readonly type: TerminalActionType.HELP }
  | { readonly type: TerminalActionType.RESET }
  | { readonly type: TerminalActionType.USAGE }
  | { readonly type: TerminalActionType.TRACE; readonly enabled?: boolean }
  | { readonly type: TerminalActionType.ACCOUNT }
  | { readonly type: TerminalActionType.LOGIN }
  | { readonly type: TerminalActionType.LOGOUT }
  | { readonly type: TerminalActionType.REVIEW }
  | { readonly type: TerminalActionType.ACCEPT_ALL }
  | { readonly type: TerminalActionType.REJECT_ALL };

export interface TerminalCommand {
  readonly value: string;
  readonly description: string;
  readonly action: TerminalCommandAction;
}

/** Complete command catalog shared by parsing, help, and prompt completion. */
export const TERMINAL_COMMANDS: readonly TerminalCommand[] = [
  { value: '/help', description: 'Show commands and keyboard help', action: { type: TerminalActionType.HELP } },
  { value: '/reset', description: 'Clear the current conversation', action: { type: TerminalActionType.RESET } },
  { value: '/usage', description: 'Show completed-request usage', action: { type: TerminalActionType.USAGE } },
  { value: '/trace', description: 'Show the current tracing state', action: { type: TerminalActionType.TRACE } },
  {
    value: '/trace on',
    description: 'Enable full provider tracing',
    action: { type: TerminalActionType.TRACE, enabled: true },
  },
  {
    value: '/trace off',
    description: 'Disable full provider tracing',
    action: { type: TerminalActionType.TRACE, enabled: false },
  },
  { value: '/review', description: 'Resume pending edit review', action: { type: TerminalActionType.REVIEW } },
  {
    value: '/accept-all',
    description: 'Accept all pending changes',
    action: { type: TerminalActionType.ACCEPT_ALL },
  },
  {
    value: '/reject-all',
    description: 'Reject all pending changes',
    action: { type: TerminalActionType.REJECT_ALL },
  },
  {
    value: '/account',
    description: 'Switch ChatGPT account or workspace',
    action: { type: TerminalActionType.ACCOUNT },
  },
  { value: '/login', description: 'Sign in to the current account', action: { type: TerminalActionType.LOGIN } },
  { value: '/logout', description: 'Sign out and exit', action: { type: TerminalActionType.LOGOUT } },
  { value: '/exit', description: 'Exit Glyph', action: { type: TerminalActionType.EXIT } },
  { value: '/quit', description: 'Exit Glyph', action: { type: TerminalActionType.EXIT } },
];

export function searchTerminalCommands(query: string): readonly TerminalCommand[] {
  const normalized = query.toLowerCase();
  return TERMINAL_COMMANDS.filter(command => command.value.startsWith(normalized));
}

export function resolveTerminalCommand(value: string): TerminalCommandAction | undefined {
  return TERMINAL_COMMANDS.find(command => command.value === value)?.action;
}
