import { useEffect, useRef, useState } from 'react';
import { useCursor, useInput, usePaste, useWindowSize } from 'ink';
import stringWidth from 'string-width';
import { FileSearchError } from '../../context/search/FileSearchError.ts';
import { FileSearchFailureReason } from '../../context/search/FileSearchFailureReason.ts';
import type { FileSearchMatch } from '../../context/search/FileSearchMatch.ts';
import { sanitizeText } from '../TerminalEditReviewer.ts';
import type { PromptRequest } from './PromptRequest.ts';

const SEARCH_LIMIT = 10;

/** Complete rendering contract produced by the prompt's interactive state hook. */
export interface PromptEditorState {
  label: string;
  text: string;
  attachments: readonly string[];
  matches: readonly FileSearchMatch[];
  selectedMatch: number;
  searchError: string;
}

export interface UsePromptEditorStateOptions {
  request: PromptRequest;
  interrupt: () => void;
}

export function usePromptEditorState({ request, interrupt }: UsePromptEditorStateOptions): PromptEditorState {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);
  const [matches, setMatches] = useState<readonly FileSearchMatch[]>([]);
  const [selectedMatch, setSelectedMatch] = useState(0);
  const [attachments, setAttachments] = useState<readonly string[]>([]);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [searchError, setSearchError] = useState('');
  const generation = useRef(0);
  const mention = activeMention(text, cursor);
  const mentionSignature = mention?.signature;
  const { columns } = useWindowSize();
  const { setCursorPosition } = useCursor();

  useEffect(() => {
    const files = request.files;
    if (!files || !mention || mention.signature === dismissedMention) {
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
  }, [dismissedMention, mentionSignature, request.files]);

  const visiblePrefix = `${request.label}${sanitizeText(text.slice(0, cursor))}`;
  const width = Math.max(1, columns);
  const cursorWidth = stringWidth(visiblePrefix);
  setCursorPosition({ x: cursorWidth % width, y: Math.floor(cursorWidth / width) });

  const updateText = (next: string, nextCursor: number): void => {
    setText(next);
    setCursor(nextCursor);
    setAttachments(current => current.filter(path => containsAttachment(next, path)));
    setDismissedMention(undefined);
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

  usePaste(value => {
    const safe = value.replace(/[\r\n]+/gu, ' ');
    updateText(`${text.slice(0, cursor)}${safe}${text.slice(cursor)}`, cursor + safe.length);
  });

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') {
      interrupt();
      return;
    }
    if (key.escape) {
      if (mention) {
        setDismissedMention(mention.signature);
        setMatches([]);
      }
      return;
    }
    if ((key.return || key.tab) && attachSelected()) return;
    if (key.return) {
      request.complete({ prompt: text.trim(), attachmentPaths: [...attachments] });
      return;
    }
    if (key.upArrow && matches.length > 0) {
      setSelectedMatch(value => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow && matches.length > 0) {
      setSelectedMatch(value => Math.min(matches.length - 1, value + 1));
      return;
    }
    if (key.leftArrow) {
      setCursor(previousCharacterOffset(text, cursor));
      return;
    }
    if (key.rightArrow) {
      setCursor(nextCharacterOffset(text, cursor));
      return;
    }
    if (key.home || (key.ctrl && input.toLowerCase() === 'a')) {
      setCursor(0);
      return;
    }
    if (key.end || (key.ctrl && input.toLowerCase() === 'e')) {
      setCursor(text.length);
      return;
    }
    if (key.backspace) {
      const previous = previousCharacterOffset(text, cursor);
      if (previous !== cursor) updateText(text.slice(0, previous) + text.slice(cursor), previous);
      return;
    }
    if (key.delete) {
      const next = nextCharacterOffset(text, cursor);
      if (next !== cursor) updateText(text.slice(0, cursor) + text.slice(next), cursor);
      return;
    }
    if (isPrintableInput(input, key.ctrl, key.meta)) {
      updateText(`${text.slice(0, cursor)}${input}${text.slice(cursor)}`, cursor + input.length);
    }
  });

  return { label: request.label, text, attachments, matches, selectedMatch, searchError };
}

function activeMention(
  text: string,
  cursor: number,
): { start: number; end: number; query: string; signature: string } | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match) return undefined;
  const query = match[1] ?? '';
  const start = cursor - query.length - 1;
  return { start, end: cursor, query, signature: `${start}:${query}` };
}

function isPrintableInput(input: string, control: boolean, meta: boolean): boolean {
  return input.length > 0 && !control && !meta && !/[\x00-\x1f\x7f]/u.test(input);
}

function isSilentSearchCancellation(error: unknown): boolean {
  return (
    (error instanceof FileSearchError && error.code === FileSearchFailureReason.SUPERSEDED) ||
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

function previousCharacterOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  return previous >= 0xdc00 &&
    previous <= 0xdfff &&
    offset > 1 &&
    text.charCodeAt(offset - 2) >= 0xd800 &&
    text.charCodeAt(offset - 2) <= 0xdbff
    ? offset - 2
    : offset - 1;
}

function nextCharacterOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const current = text.charCodeAt(offset);
  return current >= 0xd800 &&
    current <= 0xdbff &&
    text.charCodeAt(offset + 1) >= 0xdc00 &&
    text.charCodeAt(offset + 1) <= 0xdfff
    ? offset + 2
    : offset + 1;
}
