import { useState } from 'react';
import { useCursor, useInput } from 'ink';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.ts';
import type { TerminalShellPermissionRequest } from './ShellPermissionRequest.ts';

export interface ShellPermissionChoice {
  readonly decision: ShellPermissionDecision;
  readonly label: string;
  readonly description: string;
}

const choices: readonly ShellPermissionChoice[] = [
  {
    decision: ShellPermissionDecision.ALLOW_ONCE,
    label: 'Allow once',
    description: 'Run in the project-write sandbox with a sanitized environment.',
  },
  {
    decision: ShellPermissionDecision.ALWAYS_ALLOW,
    label: 'Always allow',
    description: 'Remember this exact command and keep it sandboxed with a sanitized environment.',
  },
  {
    decision: ShellPermissionDecision.ALLOW_SAFE,
    label: 'Allow safe',
    description: 'Auto-run recognized inspection commands in a read-only, offline sandbox.',
  },
  {
    decision: ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE,
    label: 'Allow outside sandbox once',
    description: 'Run once with your login shell, full environment, and user permissions.',
  },
  {
    decision: ShellPermissionDecision.ALLOW_EVERYTHING,
    label: 'Allow everything',
    description: 'Run future commands unsandboxed with your login shell and full environment.',
  },
  {
    decision: ShellPermissionDecision.DENY,
    label: 'Deny',
    description: 'Do not run the command.',
  },
];

export interface ShellPermissionState {
  readonly command: string;
  readonly workingDirectory: string;
  readonly choices: readonly ShellPermissionChoice[];
  readonly highlightedChoice: number;
}

export function useShellPermissionState(request: TerminalShellPermissionRequest, active = true): ShellPermissionState {
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined);
  const [highlightedChoice, setHighlightedChoice] = useState(0);

  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'c') {
        request.interrupt();
        return;
      }
      if (key.escape) {
        request.complete(ShellPermissionDecision.DENY);
        return;
      }
      if (key.upArrow) setHighlightedChoice(index => Math.max(0, index - 1));
      else if (key.downArrow) setHighlightedChoice(index => Math.min(choices.length - 1, index + 1));
      else if (key.return) request.complete(choices[highlightedChoice]!.decision);
      else {
        const number = Number(input);
        if (Number.isInteger(number) && number >= 1 && number <= choices.length) {
          request.complete(choices[number - 1]!.decision);
        }
      }
    },
    { isActive: active },
  );

  return {
    command: request.permission.command,
    workingDirectory: request.permission.workingDirectory,
    choices,
    highlightedChoice,
  };
}
