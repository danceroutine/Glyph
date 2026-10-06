import { stripVTControlCharacters } from 'node:util';
import { FileSearchError } from '../context/search/FileSearchError.ts';
import { FileSearchFailureReason } from '../context/search/FileSearchFailureReason.ts';
import type { FileSearchMatch } from '../context/search/FileSearchMatch.ts';
import type { WorkspaceFileSearch } from '../context/search/WorkspaceFileSearch.ts';
import type { UserPromptDraft } from './UserPromptDraft.ts';
import type { TerminalInput } from './TerminalInput.ts';

const SEARCH_LIMIT = 10;

interface ActiveMention {
  start: number;
  end: number;
  query: string;
  signature: string;
}

type PromptEvent =
  | { type: 'key'; key: string }
  | { type: 'results'; generation: number; matches: readonly FileSearchMatch[] }
  | { type: 'search-error'; generation: number; error: unknown };

/** Raw-mode line editor that attaches fuzzy-matched project files at `@`. */
export class TerminalPromptComposer {
  private generation = 0;

  constructor(
    private readonly input: TerminalInput,
    private readonly output: NodeJS.WritableStream,
    private readonly files: WorkspaceFileSearch,
  ) {}

  async compose(prompt: string, signal: AbortSignal): Promise<UserPromptDraft> {
    let text = '';
    let cursor = 0;
    let matches: readonly FileSearchMatch[] = [];
    let selected = 0;
    let searchError = '';
    let dismissedMention: string | undefined;
    const attachmentPaths: string[] = [];
    let renderedLines = 0;
    let searchAbort: AbortController | undefined;
    let searchEvent: Promise<PromptEvent> | undefined;
    let keyEvent: Promise<PromptEvent>;

    const beginSearch = (): void => {
      searchAbort?.abort();
      searchAbort = undefined;
      searchEvent = undefined;
      matches = [];
      selected = 0;
      searchError = '';
      const mention = activeMention(text, cursor);
      if (!mention || mention.signature === dismissedMention) return;
      const currentGeneration = ++this.generation;
      const controller = new AbortController();
      searchAbort = controller;
      const combined = AbortSignal.any([signal, controller.signal]);
      searchEvent = this.files
        .search(mention.query, {
          generation: currentGeneration,
          limit: SEARCH_LIMIT,
          signal: combined,
        })
        .then(result => ({
          type: 'results' as const,
          generation: result.generation,
          matches: result.matches,
        }))
        .catch(error => ({ type: 'search-error' as const, generation: currentGeneration, error }));
    };

    const render = (): void => {
      renderedLines = this.render(
        {
          prompt,
          text,
          cursor,
          attachmentPaths,
          matches,
          selected,
          searchError,
        },
        renderedLines,
      );
    };

    this.input.enterRawMode();
    try {
      keyEvent = this.nextKey(signal);
      render();
      while (!signal.aborted) {
        const event = searchEvent ? await Promise.race([keyEvent, searchEvent]) : await keyEvent;
        if (event.type === 'results') {
          searchEvent = undefined;
          if (event.generation === this.generation) {
            matches = event.matches.filter(match => isSafeAttachmentPath(match.path));
            selected = Math.min(selected, Math.max(0, matches.length - 1));
            searchError = '';
            render();
          }
          continue;
        }
        if (event.type === 'search-error') {
          searchEvent = undefined;
          if (event.generation === this.generation) {
            if (!isSilentSearchCancellation(event.error)) {
              searchError = event.error instanceof Error ? event.error.message : 'File search failed.';
            }
            render();
          }
          continue;
        }

        keyEvent = this.nextKey(signal);
        const key = event.key;
        if (key === '\x03') {
          this.input.requestInterrupt();
          signal.throwIfAborted();
          throw new Error('Input interrupted.');
        }
        if (key === '\x1b') {
          if (activeMention(text, cursor)) {
            dismissedMention = activeMention(text, cursor)?.signature;
            searchAbort?.abort();
            matches = [];
            searchEvent = undefined;
            render();
          }
          continue;
        }
        if ((key === '\r' || key === '\n' || key === '\t') && matches[selected]) {
          const mention = activeMention(text, cursor);
          if (mention) {
            const path = matches[selected]!.path;
            text = `${text.slice(0, mention.start)}@${path} ${text.slice(mention.end)}`;
            cursor = mention.start + path.length + 2;
            if (!attachmentPaths.includes(path)) attachmentPaths.push(path);
            dismissedMention = undefined;
            beginSearch();
            render();
            continue;
          }
        }
        if (key === '\r' || key === '\n') {
          retainPresentAttachments(attachmentPaths, text);
          this.clear(renderedLines);
          this.output.write(`${prompt}${sanitize(text)}${formatAttachments(attachmentPaths)}\n`);
          return { prompt: text.trim(), attachmentPaths };
        }
        if (key === '\x1b[A' && matches.length > 0) {
          selected = Math.max(0, selected - 1);
          render();
          continue;
        }
        if (key === '\x1b[B' && matches.length > 0) {
          selected = Math.min(matches.length - 1, selected + 1);
          render();
          continue;
        }
        if (key === '\x1b[D') cursor = previousCharacterOffset(text, cursor);
        else if (key === '\x1b[C') cursor = nextCharacterOffset(text, cursor);
        else if (key === '\x01' || key === '\x1b[H') cursor = 0;
        else if (key === '\x05' || key === '\x1b[F') cursor = text.length;
        else if (key === '\x7f' || key === '\b') {
          if (cursor > 0) {
            const previous = previousCharacterOffset(text, cursor);
            text = text.slice(0, previous) + text.slice(cursor);
            cursor = previous;
          }
        } else if (key === '\x1b[3~') {
          if (cursor < text.length) text = text.slice(0, cursor) + text.slice(nextCharacterOffset(text, cursor));
        } else if (isPrintable(key)) {
          text = text.slice(0, cursor) + key + text.slice(cursor);
          cursor += key.length;
        } else continue;
        retainPresentAttachments(attachmentPaths, text);
        dismissedMention = undefined;
        beginSearch();
        render();
      }
      signal.throwIfAborted();
      throw new Error('Input cancelled.');
    } finally {
      searchAbort?.abort();
      this.input.leaveRawMode();
    }
  }

  private nextKey(signal: AbortSignal): Promise<PromptEvent> {
    return this.input.nextKey(signal).then(key => ({ type: 'key', key }));
  }

  private render(
    state: {
      prompt: string;
      text: string;
      cursor: number;
      attachmentPaths: readonly string[];
      matches: readonly FileSearchMatch[];
      selected: number;
      searchError: string;
    },
    previousLines: number,
  ): number {
    this.clear(previousLines);
    const lines = [`${state.prompt}${sanitize(state.text)}`];
    if (state.attachmentPaths.length > 0) lines.push(formatAttachments(state.attachmentPaths));
    state.matches.forEach((match, index) => {
      const marker = index === state.selected ? style('›', '\u001b[36m') : ' ';
      const path = highlightMatch(sanitize(match.path), match.indices);
      lines.push(`  ${marker} ${path}`);
    });
    if (state.searchError) lines.push(`  ${style(`File search: ${sanitize(state.searchError)}`, '\u001b[31m')}`);
    this.output.write(lines.join('\n'));
    if (lines.length > 1) this.output.write(`\u001b[${lines.length - 1}A`);
    this.output.write('\r');
    const cursorColumn = visibleLength(state.prompt) + Array.from(state.text.slice(0, state.cursor)).length;
    if (cursorColumn > 0) this.output.write(`\u001b[${cursorColumn}C`);
    return lines.length;
  }

  private clear(lines: number): void {
    if (lines === 0) return;
    let output = '\r\u001b[2K';
    for (let index = 1; index < lines; index++) output += '\u001b[1B\r\u001b[2K';
    if (lines > 1) output += `\u001b[${lines - 1}A`;
    output += '\r';
    this.output.write(output);
  }
}

function activeMention(text: string, cursor: number): ActiveMention | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(beforeCursor);
  if (!match) return undefined;
  const query = match[1] ?? '';
  const start = cursor - query.length - 1;
  return { start, end: cursor, query, signature: `${start}:${query}` };
}

function isPrintable(key: string): boolean {
  return key.length > 0 && !/[\x00-\x1f\x7f]/u.test(key);
}

function isSilentSearchCancellation(error: unknown): boolean {
  return (
    (error instanceof FileSearchError && error.code === FileSearchFailureReason.SUPERSEDED) ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function retainPresentAttachments(paths: string[], text: string): void {
  for (let index = paths.length - 1; index >= 0; index--) {
    if (!containsAttachment(text, paths[index]!)) paths.splice(index, 1);
  }
}

function formatAttachments(paths: readonly string[]): string {
  return paths.length === 0 ? '' : style(`  attached: ${paths.map(sanitize).join(', ')}`, '\u001b[2m');
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

function highlightMatch(path: string, indices: readonly number[]): string {
  const selected = new Set(indices);
  return [...path]
    .map((character, index) => (selected.has(index) ? style(character, '\u001b[1;36m') : character))
    .join('');
}

function style(value: string, code: string): string {
  return process.env.NO_COLOR === undefined ? `${code}${value}\u001b[0m` : value;
}

function visibleLength(value: string): number {
  return [...stripVTControlCharacters(value)].length;
}

function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(
      /[\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
