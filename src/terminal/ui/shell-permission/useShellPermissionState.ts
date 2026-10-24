import { shellPermissionChoices } from '#src/shell/shellPermissionChoices.js';
import { useRef, useState } from 'react';
import { useCursor, useInput, useWindowSize } from 'ink';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import type { TerminalShellPermissionRequest } from './ShellPermissionRequest.ts';

export interface ShellPermissionChoice {
  readonly decision: ShellPermissionDecision;
  readonly label: string;
  readonly description: string;
}

export interface ShellPermissionState {
  readonly command: string;
  readonly workingDirectory: string;
  readonly choices: readonly ShellPermissionChoice[];
  readonly highlightedChoice: number;
}

export function useShellPermissionState(request: TerminalShellPermissionRequest, active = true): ShellPermissionState {
  const choices = shellPermissionChoices(request.permission);
  const { rows, columns } = useWindowSize();
  const settled = useRef(false);
  const choose = (decision: ShellPermissionDecision): void => {
    // The input handler checks settlement before dispatching a choice.
    if (decision !== ShellPermissionDecision.DENY && (rows < choices.length + 10 || columns < 40)) return;
    // Claim the interaction before its callback can trigger another input or
    // render: a request can authorize or interrupt, never both or twice.
    settled.current = true;
    request.complete(decision);
  };
  const { setCursorPosition } = useCursor();
  setCursorPosition(undefined);
  const [highlightedChoice, setHighlightedChoice] = useState(0);
  const currentChoice = useRef(highlightedChoice);
  const highlight = (index: number): void => {
    // Navigation and Enter can arrive in the same Ink/React batch. Permission
    // decisions must observe that navigation, not the previous rendered choice.
    currentChoice.current = index;
    setHighlightedChoice(index);
  };

  useInput(
    (input, key) => {
      if (settled.current || key.eventType === 'release') return;
      if (key.ctrl && input.toLowerCase() === 'c') {
        settled.current = true;
        request.interrupt();
        return;
      }
      if (key.escape) {
        choose(ShellPermissionDecision.DENY);
        return;
      }
      if (key.upArrow) highlight(Math.max(0, currentChoice.current - 1));
      else if (key.downArrow) highlight(Math.min(choices.length - 1, currentChoice.current + 1));
      else if (key.return) choose(choices[currentChoice.current]!.decision);
      else {
        const number = Number(input);
        if (Number.isInteger(number) && number >= 1 && number <= choices.length) {
          choose(choices[number - 1]!.decision);
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
