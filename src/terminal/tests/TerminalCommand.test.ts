import { describe, expect, it } from 'vitest';
import { TerminalActionType } from '../TerminalActionType.ts';
import { resolveTerminalCommand, searchTerminalCommands, TERMINAL_COMMANDS } from '../TerminalCommand.ts';

describe('terminal commands', () => {
  it('searches the complete catalog by case-insensitive prefix', () => {
    expect(searchTerminalCommands('/')).toEqual(TERMINAL_COMMANDS);
    expect(searchTerminalCommands('/TR').map(command => command.value)).toEqual(['/trace', '/trace on', '/trace off']);
    expect(searchTerminalCommands('/missing')).toEqual([]);
  });

  it('resolves commands and aliases to their actions', () => {
    expect(resolveTerminalCommand('/trace off')).toEqual({ type: TerminalActionType.TRACE, enabled: false });
    expect(resolveTerminalCommand('/quit')).toEqual({ type: TerminalActionType.EXIT });
    expect(resolveTerminalCommand('/missing')).toBeUndefined();
  });
});
