import { useEffect, useRef, useState } from 'react';
import { useCursor, useInput, usePaste, useWindowSize } from 'ink';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.js';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.js';
import type { FileSearchMatch } from '#src/context/search/FileSearchMatch.js';
import { searchTerminalCommands, type TerminalCommand } from '#src/terminal/TerminalCommand.js';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';
import type { PromptRequest } from './PromptRequest.ts';
import { editPrompt } from './PromptEditing.ts';
import { formatPromptText } from './formatPromptText.ts';
import { PromptLayout } from './PromptLayout.ts';
import { getPromptViewport } from './getPromptViewport.ts';

const SEARCH_LIMIT = 10;
// Prompt components remount after each turn; the index worker does not.
const searchGenerations = new WeakMap<WorkspacePathIndex, number>();

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
  viewport?: ReturnType<typeof getPromptViewport>;
}

export interface UsePromptEditorStateOptions {
  request: PromptRequest;
  interrupt: () => void;
  active: boolean;
  railTop: number | undefined;
}

interface PromptInteraction {
  readonly text: string;
  readonly cursor: number;
  readonly selectedMatch: number;
  readonly attachments: readonly string[];
  readonly dismissedCompletion: string | undefined;
}

export function usePromptEditorState({
  request,
  interrupt,
  active,
  railTop,
}: UsePromptEditorStateOptions): PromptEditorState {
  const pendingChanges = request.pendingChanges ?? 0;
  const [interaction, setInteraction] = useState<PromptInteraction>({
    text: '',
    cursor: 0,
    selectedMatch: 0,
    attachments: [],
    dismissedCompletion: undefined,
  });
  const current = useRef(interaction);
  const settled = useRef(false);
  const update = (changes: Partial<PromptInteraction>): void => {
    // Ink batches input events before React renders. Editing, completion, and
    // submission must share the latest transition rather than a frame snapshot.
    current.current = { ...current.current, ...changes };
    setInteraction(current.current);
  };
  const {
    text: renderedText,
    cursor: renderedCursor,
    selectedMatch: renderedSelectedMatch,
    attachments: renderedAttachments,
    dismissedCompletion: renderedDismissedCompletion,
  } = interaction;
  const [completion, setCompletion] = useState<{
    signature: string;
    files: WorkspacePathIndex;
    matches: readonly FileSearchMatch[];
  }>();
  const [searchError, setSearchError] = useState('');
  const generation = useRef(0);
  const promptText = formatPromptText(renderedText, renderedAttachments, renderedCursor);
  const getCompletions = (value: PromptInteraction) => {
    const { text, cursor, attachments, dismissedCompletion } = value;
    const formatted = formatPromptText(text, attachments, cursor);
    const mention = formatted.cursorTouchesAttachment ? undefined : activeMention(text, cursor);
    // Revalidate against current input both when rendering and when selecting.
    // A query can change and receive Tab before another render or search effect.
    const matches =
      completion?.signature === mention?.signature &&
      completion?.files === request.files &&
      mention?.signature !== dismissedCompletion
        ? (completion?.matches ?? [])
        : [];
    const commandQuery = activeSlashCommand(text, cursor);
    const commandMatches =
      commandQuery && commandQuery.signature !== dismissedCompletion ? searchTerminalCommands(commandQuery.query) : [];
    return { mention, matches, commandQuery, commandMatches };
  };
  const {
    mention: renderedMention,
    matches: renderedMatches,
    commandQuery: renderedCommandQuery,
    commandMatches: renderedCommandMatches,
  } = getCompletions(interaction);
  const mentionSignature = renderedMention?.signature;
  const { columns, rows } = useWindowSize();
  const { setCursorPosition } = useCursor();

  useEffect(() => {
    setCompletion(undefined);
    update({ selectedMatch: 0 });
    setSearchError('');
    const files = request.files;
    if (!files || !renderedMention || renderedMention.signature === renderedDismissedCompletion) return undefined;
    const currentGeneration = (searchGenerations.get(files) ?? 0) + 1;
    searchGenerations.set(files, currentGeneration);
    generation.current = currentGeneration;
    const controller = new AbortController();
    void files
      .search(renderedMention.query, { generation: currentGeneration, limit: SEARCH_LIMIT, signal: controller.signal })
      .then(result => {
        if (
          controller.signal.aborted ||
          result.generation !== currentGeneration ||
          result.generation !== generation.current ||
          result.query !== renderedMention.query
        )
          return;
        const safeMatches = result.matches.filter(match => isSafeAttachmentPath(match.path));
        setCompletion({ signature: renderedMention.signature, files, matches: safeMatches });
        update({ selectedMatch: Math.min(current.current.selectedMatch, Math.max(0, safeMatches.length - 1)) });
        setSearchError('');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || currentGeneration !== generation.current || isSilentSearchCancellation(error))
          return;
        setCompletion(undefined);
        setSearchError(error instanceof Error ? error.message : 'File search failed.');
      });
    return () => {
      controller.abort();
    };
  }, [renderedDismissedCompletion, mentionSignature, request.files]);

  const visiblePrefix = `${request.label}${sanitizeText(promptText.cursorPrefix)}`;
  const renderedCompletionCount = renderedCommandQuery ? renderedCommandMatches.length : renderedMatches.length;
  const viewport = getPromptViewport({
    text: request.label + promptText.segments.map(segment => sanitizeText(segment.value)).join(''),
    prefix: visiblePrefix,
    columns,
    rows,
    overhead:
      2 +
      Number(pendingChanges > 0) +
      Number(!request.acceptsSubmission) +
      Math.min(3, renderedCompletionCount) +
      Number(Boolean(searchError)),
  });
  if (active && railTop !== undefined) {
    setCursorPosition({
      x: PromptLayout.railHorizontalPadding + viewport.cursorX,
      y: PromptLayout.railCursorY(railTop, pendingChanges, request.acceptsSubmission) + viewport.cursorY,
    });
  }

  const updateText = (next: string, nextCursor: number): void => {
    update({
      text: next,
      cursor: nextCursor,
      attachments: current.current.attachments.filter(path => containsAttachment(next, path)),
      dismissedCompletion: undefined,
      selectedMatch: 0,
    });
  };

  const completeSelectedCommand = (): boolean => {
    const candidate = getCompletions(current.current).commandMatches[current.current.selectedMatch];
    if (!candidate) return false;
    updateText(`${candidate.value} `, candidate.value.length + 1);
    return true;
  };

  const attachSelected = (): boolean => {
    const { text, selectedMatch } = current.current;
    const { matches, mention: mentionAtCursor } = getCompletions(current.current);
    const candidate = matches[selectedMatch];
    if (!candidate || !mentionAtCursor) return false;
    const next = `${text.slice(0, mentionAtCursor.start)}@${candidate.path} ${text.slice(mentionAtCursor.end)}`;
    updateText(next, mentionAtCursor.start + candidate.path.length + 2);
    const attachments = current.current.attachments;
    if (!attachments.includes(candidate.path)) update({ attachments: [...attachments, candidate.path] });
    setCompletion(undefined);
    return true;
  };

  usePaste(
    value => {
      if (settled.current) return;
      const { text, cursor } = current.current;
      const safe = value.replaceAll(/[\r\n]+/gu, ' ');
      updateText(`${text.slice(0, cursor)}${safe}${text.slice(cursor)}`, cursor + safe.length);
    },
    { isActive: active },
  );

  useInput(
    (input, key) => {
      if (key.eventType === 'release' || settled.current) return;
      const { text, cursor, selectedMatch, attachments } = current.current;
      const { mention, matches, commandQuery, commandMatches } = getCompletions(current.current);
      if (key.ctrl && input.toLowerCase() === 'c') {
        interrupt();
        return;
      }
      if (key.escape) {
        const dismissible = commandQuery ?? mention;
        if (dismissible) {
          update({ dismissedCompletion: dismissible.signature });
          setCompletion(undefined);
        }
        return;
      }
      if (key.return && !request.acceptsSubmission) return;
      if (key.return && request.acceptsSubmission) {
        const command = commandMatches[selectedMatch];
        if (command) {
          settled.current = true;
          request.complete({ prompt: command.value, attachmentPaths: [] });
          return;
        }
        if (attachSelected()) return;
        settled.current = true;
        request.complete({ prompt: text.trim(), attachmentPaths: [...attachments] });
        return;
      }
      if (key.tab && completeSelectedCommand()) return;
      if (key.tab && attachSelected()) return;
      const edit = editPrompt(input, key, text, cursor);
      if (edit) {
        if (edit.text === text) update({ cursor: edit.cursor });
        else updateText(edit.text, edit.cursor);
        return;
      }
      const completionCount = commandQuery ? commandMatches.length : matches.length;
      if (key.upArrow && !key.ctrl && !key.meta && !key.super && completionCount > 0) {
        update({ selectedMatch: Math.max(0, selectedMatch - 1) });
        return;
      }
      if (key.downArrow && !key.ctrl && !key.meta && !key.super && completionCount > 0) {
        update({ selectedMatch: Math.min(completionCount - 1, selectedMatch + 1) });
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
    text: renderedText,
    cursor: renderedCursor,
    attachments: renderedAttachments,
    matches: renderedCommandQuery ? [] : renderedMatches,
    commandMatches: renderedCommandMatches,
    selectedMatch: renderedSelectedMatch,
    searchError,
    viewport,
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
  return input.length > 0 && !control && !meta && !/[\u0000-\u001F\u007F]/u.test(input);
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
  return !/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(path);
}
