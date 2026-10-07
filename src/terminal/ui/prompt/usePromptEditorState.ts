import { useEffect, useRef, useState } from 'react';
import { useCursor, useInput, usePaste, useWindowSize } from 'ink';
import stringWidth from 'string-width';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.ts';
import type { FileSearchMatch } from '#src/context/search/FileSearchMatch.ts';
import { searchTerminalCommands, type TerminalCommand } from '../../TerminalCommand.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';
import type { PromptRequest } from './PromptRequest.ts';
import { editPrompt } from './PromptEditing.ts';
import { formatPromptText } from './formatPromptText.ts';
import { PromptLayout } from './PromptLayout.ts';

const SEARCH_LIMIT = 10;

/** Complete rendering contract produced by the prompt's interactive state hook. */
export interface PromptEditorState {
  label: string;
  acceptsSubmission: boolean;
  pendingChanges: number;
  text: string;
  cursor: number;
  attachments: readonly string[];
  matches: readonly FileSearchMatch[];
  commandMatches: readonly TerminalCommand[];
  selectedMatch: number;
  searchError: string;
}

export interface UsePromptEditorStateOptions {
  request: PromptRequest;
  interrupt: () => void;
  active: boolean;
  railTop: number | undefined;
}

export function usePromptEditorState({
  request,
  interrupt,
  active,
  railTop,
}: UsePromptEditorStateOptions): PromptEditorState {
  const pendingChanges = request.pendingChanges ?? 0;
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [matches, setMatches] = useState<readonly FileSearchMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState(0);
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [dismissedCompletion, setDismissedCompletion] = useState<string>();
  const [searchError, setSearchError] = useState('');
  const generation = useRef(0);
  const promptText = formatPromptText(text, attachments, cursor);
  const mention = promptText.cursorTouchesAttachment ? undefined : activeMention(text, cursor);
  const mentionSignature = mention?.signature;
  const commandQuery = activeSlashCommand(text, cursor);
  const commandMatches =
    commandQuery && commandQuery.signature !== dismissedCompletion ? searchTerminalCommands(commandQuery.query) : [];
  const { columns } = useWindowSize();
  const { setCursorPosition } = useCursor();

  useEffect(() => {
    const files = request.files;
    if (!files || !mention || mention.signature === dismissedCompletion) {
      setMatches([]);
      setSelectedMatch(0);
      setSearchError('');
      return;
    }
    const currentGeneration = ++generation.current;
    const controller = new AbortController();
    void files
      .search(mention.query, { generation: currentGeneration, limit: SEARCH_LIMIT, signal: controller.signal })
      .then(result => {
        if (result.generation !== generation.current) return;
        const safeMatches = result.matches.filter(match => isSafeAttachmentPath(match.path));
        setMatches(safeMatches);
        setSelectedMatch(value => Math.min(value, Math.max(0, safeMatches.length - 1)));
        setSearchError('');
      })
      .catch((error: unknown) => {
        if (currentGeneration !== generation.current || isSilentSearchCancellation(error)) return;
        setMatches([]);
        setSearchError(error instanceof Error ? error.message : 'File search failed.');
      });
    return () => controller.abort();
  }, [dismissedCompletion, mentionSignature, request.files]);

  const visiblePrefix = `${request.label}${sanitizeText(promptText.cursorPrefix)}`;
  const width = Math.max(1, columns - PromptLayout.railHorizontalPadding * 2);
  const cursorWidth = stringWidth(visiblePrefix);
  if (active && railTop !== undefined) {
    setCursorPosition({
      x: PromptLayout.railHorizontalPadding + (cursorWidth % width),
      y: PromptLayout.railCursorY(railTop, pendingChanges, request.acceptsSubmission) + Math.floor(cursorWidth / width),
    });
  }

  const updateText = (next: string, nextCursor: number): void => {
    setText(next);
    setCursor(nextCursor);
    setAttachments(current => current.filter(path => containsAttachment(next, path)));
    setDismissedCompletion(undefined);
    setSelectedMatch(0);
  };

  const completeSelectedCommand = (): boolean => {
    const candidate = commandMatches[selectedMatch];
    if (!candidate) return false;
    updateText(`${candidate.value} `, candidate.value.length + 1);
    return true;
  };

  const attachSelected = (): boolean => {
    const candidate = matches[selectedMatch];
    const active = activeMention(text, cursor);
    if (!candidate || !active) return false;
    const next = `${text.slice(0, active.start)}@${candidate.path} ${text.slice(active.end)}`;
    updateText(next, active.start + candidate.path.length + 2);
    setAttachments(current => (current.includes(candidate.path) ? current : [...current, candidate.path]));
    setMatches([]);
    return true;
  };

  usePaste(
    value => {
      const safe = value.replace(/[\r\n]+/gu, ' ');
      updateText(`${text.slice(0, cursor)}${safe}${text.slice(cursor)}`, cursor + safe.length);
    },
    { isActive: active },
  );

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;
      if (key.ctrl && input.toLowerCase() === 'c') {
        interrupt();
        return;
      }
      if (key.escape) {
        const completion = commandQuery ?? mention;
        if (completion) {
          setDismissedCompletion(completion.signature);
          setMatches([]);
        }
        return;
      }
      if (key.return && !request.acceptsSubmission) return;
      if (key.return && request.acceptsSubmission) {
        const command = commandMatches[selectedMatch];
        if (command) {
          request.complete({ prompt: command.value, attachmentPaths: [] });
          return;
        }
        if (attachSelected()) return;
        request.complete({ prompt: text.trim(), attachmentPaths: [...attachments] });
        return;
      }
      if (key.tab && completeSelectedCommand()) return;
      if (key.tab && attachSelected()) return;
      const edit = editPrompt(input, key, text, cursor);
      if (edit) {
        if (edit.text === text) setCursor(edit.cursor);
        else updateText(edit.text, edit.cursor);
        return;
      }
      const completionCount = commandQuery ? commandMatches.length : matches.length;
      if (key.upArrow && !key.ctrl && !key.meta && !key.super && completionCount > 0) {
        setSelectedMatch(value => Math.max(0, value - 1));
        return;
      }
      if (key.downArrow && !key.ctrl && !key.meta && !key.super && completionCount > 0) {
        setSelectedMatch(value => Math.min(completionCount - 1, value + 1));
        return;
      }
      if (isPrintableInput(input, key.ctrl, key.meta)) {
        updateText(`${text.slice(0, cursor)}${input}${text.slice(cursor)}`, cursor + input.length);
      }
    },
    { isActive: active },
  );

  return {
    label: request.label,
    acceptsSubmission: request.acceptsSubmission,
    pendingChanges,
    text,
    cursor,
    attachments,
    matches: commandQuery ? [] : matches,
    commandMatches,
    selectedMatch,
    searchError,
  };
}

function activeSlashCommand(text: string, cursor: number): { query: string; signature: string } | undefined {
  if (!text.startsWith('/')) return undefined;
  const query = text.slice(0, cursor);
  return { query, signature: `command:${query}` };
}

function activeMention(
  text: string,
  cursor: number,
): { start: number; end: number; query: string; signature: string } | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match) return undefined;
  const query = match[1]!;
  const start = cursor - query.length - 1;
  return { start, end: cursor, query, signature: `${start}:${query}` };
}

function isPrintableInput(input: string, control: boolean, meta: boolean): boolean {
  return input.length > 0 && !control && !meta && !/[\x00-\x1f\x7f]/u.test(input);
}

function isSilentSearchCancellation(error: unknown): boolean {
  return (
    (error instanceof WorkspacePathIndexError && error.code === WorkspacePathIndexFailureReason.SUPERSEDED) ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function containsAttachment(text: string, path: string): boolean {
  const mention = `@${path}`;
  for (let offset = text.indexOf(mention); offset >= 0; offset = text.indexOf(mention, offset + 1)) {
    const before = text[offset - 1];
    const after = text[offset + mention.length];
    if ((before === undefined || /\s/u.test(before)) && (after === undefined || /\s/u.test(after))) return true;
  }
  return false;
}

function isSafeAttachmentPath(path: string): boolean {
  return !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(path);
}
