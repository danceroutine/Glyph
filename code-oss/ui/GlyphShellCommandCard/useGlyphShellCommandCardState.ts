import { useRef, useState } from 'preact/hooks';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import type { GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export interface GlyphShellCommandCardStateOptions {
  readonly activity: GlyphToolActivity & { readonly shell: GlyphShellCommand };
  readonly chatId: string;
  readonly readOnly: boolean;
  readonly actions: Pick<GlyphWorkbenchViewActions, 'writeShellInput' | 'stopShell'>;
}
export type GlyphShellCommandCardState = ReturnType<typeof useGlyphShellCommandCardState>;

export function useGlyphShellCommandCardState({
  activity,
  chatId,
  readOnly,
  actions,
}: GlyphShellCommandCardStateOptions) {
  const shell = activity.shell;
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState('');
  const [appendNewline, setAppendNewline] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const act = async (operation: () => Promise<void>, clearInput: boolean) => {
    if (readOnly || !shell.live || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
      if (clearInput) setInput('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const failed =
    (shell.error !== undefined && shell.error !== '') || (shell.exitCode !== undefined && shell.exitCode !== 0);
  const status = toShellStatus(shell, activity.status);
  const lines = shell.output.trimEnd().split('\n');
  return {
    shell,
    expanded,
    input,
    appendNewline,
    pending,
    error,
    status,
    failed,
    preview: lines.slice(-3).join('\n'),
    disabled: readOnly || pending,
    canSend: shell.live && shell.running && !readOnly && !pending && (input.length > 0 || appendNewline),
    toggle: () => {
      setExpanded(value => !value);
    },
    changeInput: setInput,
    changeAppendNewline: setAppendNewline,
    sendInput: () => {
      if (shell.running && shell.sessionId !== undefined && shell.sessionId !== '')
        void act(() => actions.writeShellInput(chatId, shell.sessionId!, input, appendNewline), true);
    },
    close: () => {
      if (shell.sessionId !== undefined && shell.sessionId !== '')
        void act(() => actions.stopShell(chatId, shell.sessionId!), false);
    },
  };
}

function toShellStatus(shell: GlyphShellCommand, status: GlyphToolActivityStatus): string {
  if (status === GlyphToolActivityStatus.INTERRUPTED) return 'Interrupted';
  if (shell.running) return 'Running';
  if (shell.exitCode !== undefined) return `${shell.exitCode === 0 ? '' : 'Failed · '}Exit ${shell.exitCode}`;
  if (shell.error !== undefined && shell.error !== '') return 'Failed';
  if (shell.live) return 'Idle';
  if (status === GlyphToolActivityStatus.STARTED) return 'Waiting';
  return shell.background ? 'Closed' : 'Finished';
}
