import { extname } from 'node:path';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { Theme } from 'cli-highlight';
import wrapAnsi from 'wrap-ansi';
import type { EditProposal } from '../../../editing/proposals/EditProposal.ts';
import type { FileEditPlan } from '../../../editing/proposals/FileEditPlan.ts';
import { EditDecisionState } from '../../../editing/reviews/EditDecisionState.ts';
import type { EditReviewItem } from '../../../editing/reviews/EditReviewItem.ts';
import { EditReviewItemKind } from '../../../editing/reviews/EditReviewItemKind.ts';
import type { ProposalReviewManager } from '../../../editing/reviews/ProposalReviewManager.ts';
import type { TerminalUI } from '../../TerminalUI.tsx';
import { sanitizeText } from '../shared/sanitizeText.ts';

const FOCUSED_CONTEXT_LINES = 4;

const TerminalReviewColor = {
  ADDITION: '\x1b[1;32m',
  ADDITION_BACKGROUND: '\x1b[48;5;22m',
  DELETION: '\x1b[1;31m',
  DELETION_BACKGROUND: '\x1b[48;5;52m',
  DIM: '\x1b[2;90m',
  ERROR: '\x1b[1;31m',
  HEADING: '\x1b[1;36m',
  SELECTED: '\x1b[1;36m',
  WARNING: '\x1b[33m',
} as const;

export enum ReviewViewMode {
  FOCUSED = 'FOCUSED',
  FULL_FILE = 'FULL_FILE',
}

enum DiffLineKind {
  CONTEXT = 'CONTEXT',
  ADDITION = 'ADDITION',
  DELETION = 'DELETION',
}

export interface ReviewEntry {
  review: EditProposal;
  file: FileEditPlan;
  item: EditReviewItem;
  fileNumber: number;
  fileCount: number;
  changeNumber: number;
  changeCount: number;
}

export interface RenderedEntry {
  lines: string[];
  focusLine: number;
}

interface DiffDisplayLine {
  kind: DiffLineKind;
  text: string;
  lineEnding: string;
  oldLine?: number;
  newLine?: number;
  selected: boolean;
  decision?: EditDecisionState;
}

interface ExactTextLine {
  text: string;
  lineEnding: string;
}

/** Connects proposal-review domain operations to the Ink terminal host. */
export class TerminalEditReviewer {
  constructor(
    private readonly terminal: TerminalUI,
    private readonly onInterrupt: () => void = () => {},
  ) {}

  async review(manager: ProposalReviewManager, signal: AbortSignal): Promise<void> {
    await this.terminal.reviewProposals(manager, signal, this.onInterrupt);
  }
}

export function reviewEntries(proposals: readonly EditProposal[]): ReviewEntry[] {
  const files = proposals.flatMap(review => review.files.map(file => ({ review, file })));
  return files.flatMap(({ review, file }, fileIndex) =>
    file.items.map((item, changeIndex) => ({
      review,
      file,
      item,
      fileNumber: fileIndex + 1,
      fileCount: files.length,
      changeNumber: changeIndex + 1,
      changeCount: file.items.length,
    })),
  );
}

export function mergeReviewEntries(
  existing: readonly ReviewEntry[],
  proposals: readonly EditProposal[],
): ReviewEntry[] {
  const known = new Set(existing.map(entry => reviewItemKey(entry.review.id, entry.item.id)));
  const additions = reviewEntries(proposals).filter(entry => !known.has(reviewItemKey(entry.review.id, entry.item.id)));
  return numberReviewEntries([...existing, ...additions]);
}

export function pendingEntries(proposals: readonly EditProposal[]): ReviewEntry[] {
  return pendingReviewEntries(reviewEntries(proposals));
}

export function pendingReviewEntries(entries: readonly ReviewEntry[]): ReviewEntry[] {
  return entries.filter(entry => entry.item.decision === EditDecisionState.PENDING);
}

function numberReviewEntries(entries: readonly ReviewEntry[]): ReviewEntry[] {
  const fileKeys = [...new Set(entries.map(entry => reviewFileKey(entry.review.id, entry.file.id)))];
  const changeCounts = new Map<string, number>();
  const changeNumbers = new Map<string, number>();
  for (const entry of entries) {
    const key = reviewFileKey(entry.review.id, entry.file.id);
    changeCounts.set(key, (changeCounts.get(key) ?? 0) + 1);
  }
  return entries.map(entry => {
    const key = reviewFileKey(entry.review.id, entry.file.id);
    const changeNumber = (changeNumbers.get(key) ?? 0) + 1;
    changeNumbers.set(key, changeNumber);
    return {
      ...entry,
      fileNumber: fileKeys.indexOf(key) + 1,
      fileCount: fileKeys.length,
      changeNumber,
      changeCount: changeCounts.get(key)!,
    };
  });
}

function reviewFileKey(reviewId: string, fileId: string): string {
  return `${reviewId}\u0000${fileId}`;
}

function reviewItemKey(reviewId: string, itemId: string): string {
  return `${reviewId}\u0000${itemId}`;
}

export function renderEntry(
  file: FileEditPlan,
  item: EditReviewItem,
  mode: ReviewViewMode,
  colors: boolean,
): RenderedEntry {
  const path = `${file.sourcePath}${file.targetPath !== file.sourcePath ? ` → ${file.targetPath}` : ''}`;
  const title = style(`${file.operation} ${sanitizeText(path)}`, TerminalReviewColor.HEADING, colors);
  if (item.kind === EditReviewItemKind.RENAME && mode === ReviewViewMode.FOCUSED) {
    return {
      lines: [
        title,
        style('Rename path', TerminalReviewColor.DIM, colors),
        style(`- ${sanitizeText(file.sourcePath)}`, TerminalReviewColor.DELETION, colors),
        style(`+ ${sanitizeText(file.targetPath)}`, TerminalReviewColor.ADDITION, colors),
      ],
      focusLine: 2,
    };
  }

  const allDiffLines = createFileDiffLines(file, item);
  const selectedStart = Math.max(
    0,
    allDiffLines.findIndex(line => line.selected),
  );
  const selectedEnd = Math.max(
    selectedStart,
    allDiffLines.findLastIndex(line => line.selected),
  );
  let start = 0;
  let end = allDiffLines.length;
  if (mode === ReviewViewMode.FOCUSED && item.kind === EditReviewItemKind.TEXT) {
    start = Math.max(0, selectedStart - FOCUSED_CONTEXT_LINES);
    end = Math.min(allDiffLines.length, selectedEnd + FOCUSED_CONTEXT_LINES + 1);
  }

  const selectedFileItem = file.items.indexOf(item) + 1;
  const details =
    mode === ReviewViewMode.FULL_FILE
      ? `Full file • selected change ${selectedFileItem}/${file.items.length}`
      : `Focused change ${selectedFileItem}/${file.items.length} • press F for the full file`;
  const lines = [title, style(details, TerminalReviewColor.DIM, colors)];
  if (item.kind === EditReviewItemKind.RENAME) {
    lines.push(
      style(`- ${sanitizeText(file.sourcePath)}`, TerminalReviewColor.DELETION, colors),
      style(`+ ${sanitizeText(file.targetPath)}`, TerminalReviewColor.ADDITION, colors),
      '',
    );
  }
  if (start > 0) lines.push(style(`⋯ ${start} diff lines above`, TerminalReviewColor.DIM, colors));
  const lineNumberWidth = diffLineNumberWidth(allDiffLines);
  const diffStart = lines.length;
  const visibleDiff = allDiffLines.slice(start, end);
  if (visibleDiff.length === 0) lines.push(style('  <empty file>', TerminalReviewColor.DIM, colors));
  else lines.push(...visibleDiff.map(line => renderDiffLine(line, file.targetPath, lineNumberWidth, colors)));
  if (end < allDiffLines.length) {
    lines.push(style(`⋯ ${allDiffLines.length - end} diff lines below`, TerminalReviewColor.DIM, colors));
  }
  const focusOffset = clamp(selectedStart - start, 0, Math.max(0, visibleDiff.length - 1));
  return { lines, focusLine: diffStart + focusOffset };
}

function createFileDiffLines(file: FileEditPlan, selectedItem: EditReviewItem): DiffDisplayLine[] {
  if (selectedItem.kind === EditReviewItemKind.CREATE) {
    return toDiffLines(selectedItem.insertedText, DiffLineKind.ADDITION, { old: 1, proposed: 1 }, selectedItem, true);
  }
  if (selectedItem.kind === EditReviewItemKind.DELETE) {
    return toDiffLines(selectedItem.removedText, DiffLineKind.DELETION, { old: 1, proposed: 1 }, selectedItem, true);
  }

  const base = file.base?.text ?? '';
  const textItems = file.items
    .filter(candidate => candidate.kind === EditReviewItemKind.TEXT && candidate.decision === EditDecisionState.PENDING)
    .sort((left, right) => left.sourceStart - right.sourceStart);
  const lineNumbers = { old: 1, proposed: 1 };
  const result: DiffDisplayLine[] = [];
  let sourceOffset = 0;
  for (const candidate of textItems) {
    result.push(
      ...toDiffLines(
        base.slice(sourceOffset, candidate.sourceStart),
        DiffLineKind.CONTEXT,
        lineNumbers,
        undefined,
        false,
      ),
      ...toDiffLines(
        candidate.removedText,
        DiffLineKind.DELETION,
        lineNumbers,
        candidate,
        candidate.id === selectedItem.id,
      ),
      ...toDiffLines(
        candidate.insertedText,
        DiffLineKind.ADDITION,
        lineNumbers,
        candidate,
        candidate.id === selectedItem.id,
      ),
    );
    sourceOffset = candidate.sourceEnd;
  }
  result.push(...toDiffLines(base.slice(sourceOffset), DiffLineKind.CONTEXT, lineNumbers, undefined, false));
  return result;
}

function toDiffLines(
  text: string,
  kind: DiffLineKind,
  lineNumbers: { old: number; proposed: number },
  item: EditReviewItem | undefined,
  selected: boolean,
): DiffDisplayLine[] {
  return exactLines(text).map(line => {
    const display: DiffDisplayLine = {
      kind,
      text: line.text,
      lineEnding: line.lineEnding,
      selected,
      ...(item ? { decision: item.decision } : {}),
      ...(kind !== DiffLineKind.ADDITION ? { oldLine: lineNumbers.old++ } : {}),
      ...(kind !== DiffLineKind.DELETION ? { newLine: lineNumbers.proposed++ } : {}),
    };
    return display;
  });
}

function exactLines(text: string): ExactTextLine[] {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  return lines.map(value => {
    const lineEnding = value.endsWith('\r\n') ? '\r\n' : value.endsWith('\r') ? '\r' : value.endsWith('\n') ? '\n' : '';
    return { text: lineEnding ? value.slice(0, -lineEnding.length) : value, lineEnding };
  });
}

function renderDiffLine(line: DiffDisplayLine, path: string, lineNumberWidth: number, colors: boolean): string {
  const oldLine = line.oldLine?.toString().padStart(lineNumberWidth) ?? ' '.repeat(lineNumberWidth);
  const newLine = line.newLine?.toString().padStart(lineNumberWidth) ?? ' '.repeat(lineNumberWidth);
  const indicator = line.selected
    ? style('›', TerminalReviewColor.SELECTED, colors)
    : line.kind === DiffLineKind.CONTEXT
      ? ' '
      : style('·', TerminalReviewColor.DIM, colors);
  const marker =
    line.kind === DiffLineKind.ADDITION
      ? style('+', TerminalReviewColor.ADDITION, colors)
      : line.kind === DiffLineKind.DELETION
        ? style('-', TerminalReviewColor.DELETION, colors)
        : ' ';
  const gutterColor =
    line.kind === DiffLineKind.ADDITION
      ? TerminalReviewColor.ADDITION
      : line.kind === DiffLineKind.DELETION
        ? TerminalReviewColor.DELETION
        : TerminalReviewColor.DIM;
  const gutter = style(`${oldLine} ${newLine} │`, gutterColor, colors);
  const source = highlightSourceLine(line.text, path, colors);
  const lineEnding = renderLineEnding(line.lineEnding, colors);
  const content = `${source}${lineEnding}`;
  const background =
    line.kind === DiffLineKind.ADDITION
      ? TerminalReviewColor.ADDITION_BACKGROUND
      : line.kind === DiffLineKind.DELETION
        ? TerminalReviewColor.DELETION_BACKGROUND
        : undefined;
  return `${indicator}${marker} ${gutter} ${background && colors ? background : ''}${content}${background && colors ? '\x1b[49m' : ''}`;
}

function highlightSourceLine(value: string, path: string, colors: boolean): string {
  const safe = sanitizeText(value);
  const trailingWhitespace = /[ \t]+$/u.exec(safe)?.[0] ?? '';
  const source = safe.slice(0, safe.length - trailingWhitespace.length).replace(/\t/gu, '→   ');
  const visibleTrailingWhitespace = [...trailingWhitespace]
    .map(character => (character === '\t' ? '→···' : '·'))
    .join('');
  const language = languageForPath(path);
  let highlighted = source;
  if (colors && language) {
    try {
      highlighted = highlight(source, { language, ignoreIllegals: true, theme: SYNTAX_THEME });
    } catch {
      highlighted = source;
    }
  }
  return `${highlighted}${style(visibleTrailingWhitespace, TerminalReviewColor.WARNING, colors)}`;
}

function renderLineEnding(lineEnding: string, colors: boolean): string {
  if (lineEnding === '\r\n') return style(' ↵CRLF', TerminalReviewColor.DIM, colors);
  if (lineEnding === '\r') return style(' ↵CR', TerminalReviewColor.DIM, colors);
  if (lineEnding === '\n') return style(' ↵', TerminalReviewColor.DIM, colors);
  return style('  ␄ no final newline', TerminalReviewColor.WARNING, colors);
}

function languageForPath(path: string): string | undefined {
  const fileName = path.split('/').at(-1)!.toLowerCase();
  if (fileName === 'dockerfile') return 'dockerfile';
  if (fileName === 'makefile') return 'makefile';
  const language = LANGUAGE_BY_EXTENSION[extname(fileName)] ?? extname(fileName).slice(1);
  return language && supportsLanguage(language) ? language : undefined;
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.cjs': 'javascript',
  '.cts': 'typescript',
  '.gql': 'graphql',
  '.h': 'c',
  '.htm': 'xml',
  '.html': 'xml',
  '.jsx': 'javascript',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.rs': 'rust',
  '.sh': 'bash',
  '.toml': 'ini',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.yml': 'yaml',
};

const SYNTAX_THEME: Theme = {
  keyword: ansi('\x1b[35m'),
  built_in: ansi('\x1b[36m'),
  type: ansi('\x1b[36m'),
  literal: ansi('\x1b[35m'),
  number: ansi('\x1b[33m'),
  regexp: ansi('\x1b[31m'),
  string: ansi('\x1b[32m'),
  class: ansi('\x1b[36m'),
  function: ansi('\x1b[34m'),
  title: ansi('\x1b[34m'),
  comment: ansi('\x1b[2;90m', '\x1b[22;39m'),
  doctag: ansi('\x1b[2;90m', '\x1b[22;39m'),
  meta: ansi('\x1b[90m'),
  tag: ansi('\x1b[36m'),
  name: ansi('\x1b[34m'),
  attr: ansi('\x1b[33m'),
  variable: ansi('\x1b[36m'),
  link: ansi('\x1b[4;34m', '\x1b[24;39m'),
};

function ansi(open: string, close = '\x1b[39m'): (value: string) => string {
  return value => `${open}${value}${close}`;
}

function diffLineNumberWidth(lines: readonly DiffDisplayLine[]): number {
  return Math.max(
    1,
    ...lines.flatMap(line => [line.oldLine ?? 0, line.newLine ?? 0]).map(line => line.toString().length),
  );
}

export function wrapReviewLines(rendered: RenderedEntry, width: number): RenderedEntry {
  const lines: string[] = [];
  let focusLine = 0;
  rendered.lines.forEach((line, index) => {
    if (index === rendered.focusLine) focusLine = lines.length;
    lines.push(...wrapAnsi(line, width, { hard: true, trim: false }).split('\n'));
  });
  return { lines, focusLine };
}

function style(value: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${value}\x1b[0m` : value;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
