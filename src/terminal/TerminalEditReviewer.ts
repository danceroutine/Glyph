import { stripVTControlCharacters } from 'node:util';
import wrapAnsi from 'wrap-ansi';
import { EditDecisionState } from '../editing/reviews/EditDecisionState.ts';
import type { EditProposal } from '../editing/proposals/EditProposal.ts';
import type { EditReviewItem } from '../editing/reviews/EditReviewItem.ts';
import { EditReviewItemKind } from '../editing/reviews/EditReviewItemKind.ts';
import type { ProposalReviewManager } from '../editing/reviews/ProposalReviewManager.ts';
import type { FileEditPlan } from '../editing/proposals/FileEditPlan.ts';
import type { TerminalInput } from './TerminalInput.ts';

export class TerminalEditReviewer {
  private selection = 0;
  private scroll = 0;
  private pendingPrefix = '';
  private diagnostic = '';

  constructor(
    private readonly input: TerminalInput,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly onInterrupt: () => void = () => {},
  ) {}

  async review(manager: ProposalReviewManager, signal: AbortSignal): Promise<void> {
    if (!manager.active) return;
    if (!this.input.isTTY) return this.reviewFallback(manager, signal);
    this.output.write('\x1b[?1049h\x1b[?25l');
    this.input.enterRawMode();
    try {
      while (manager.active && !signal.aborted) {
        const entries = pendingEntries(manager.active);
        if (entries.length === 0) return;
        this.selection = Math.max(0, Math.min(this.selection, entries.length - 1));
        this.render(manager.active, entries);
        const key = await this.input.nextKey(signal);
        if (key === '\x03') {
          this.onInterrupt();
          return;
        }
        if (key === '\x1b' || key.toLowerCase() === 'q') return;
        if (key === 'Y' || key === 'y') {
          try {
            await manager.accept(entries[this.selection]!.item.id);
            this.diagnostic = '';
          } catch (error) {
            this.diagnostic = error instanceof Error ? error.message : String(error);
          }
          continue;
        }
        if (key === 'N' || key === 'n') {
          try {
            await manager.reject(entries[this.selection]!.item.id);
            this.diagnostic = '';
          } catch (error) {
            this.diagnostic = error instanceof Error ? error.message : String(error);
          }
          continue;
        }
        this.navigate(key, entries);
      }
    } finally {
      this.input.leaveRawMode();
      this.output.write('\x1b[?25h\x1b[?1049l');
    }
  }

  private async reviewFallback(manager: ProposalReviewManager, signal: AbortSignal): Promise<void> {
    while (manager.active) {
      const entry = pendingEntries(manager.active)[0];
      if (!entry) return;
      this.output.write(`${renderEntry(entry.file, entry.item)}\n`);
      const answer = (await this.input.question('Accept? [y/n/q]: ', signal)).trim().toLowerCase();
      if (answer === 'q') return;
      try {
        if (answer === 'y') await manager.accept(entry.item.id);
        else if (answer === 'n') await manager.reject(entry.item.id);
      } catch (error) {
        this.output.write(`Error: ${sanitize(error instanceof Error ? error.message : String(error))}\n`);
      }
    }
  }

  private render(proposal: EditProposal, entries: ReturnType<typeof pendingEntries>): void {
    const entry = entries[this.selection]!;
    const width = Math.max(40, (this.output as NodeJS.WriteStream).columns ?? 100);
    const height = Math.max(12, (this.output as NodeJS.WriteStream).rows ?? 30);
    const body = wrapAnsi(renderEntry(entry.file, entry.item), width - 2, { hard: true, trim: false }).split('\n');
    const visible = body.slice(this.scroll, this.scroll + height - 5);
    const accepted = proposal.files
      .flatMap(file => file.items)
      .filter(item => item.decision === EditDecisionState.ACCEPTED).length;
    const rejected = proposal.files
      .flatMap(file => file.items)
      .filter(item => item.decision === EditDecisionState.REJECTED).length;
    const header = `Edit review ${this.selection + 1}/${entries.length}  accepted ${accepted}  rejected ${rejected}`;
    const footer = 'Y accept  N reject  j/k scroll  h/l file  [c/]c change  gg/G ends  Q/Esc defer';
    const diagnostic = this.diagnostic ? `\nError: ${sanitize(this.diagnostic)}` : '';
    this.output.write(
      `\x1b[H\x1b[2J${sanitize(header)}${diagnostic}\n${visible.map(sanitize).join('\n')}\n${sanitize(footer)}`,
    );
  }

  private navigate(key: string, entries: ReturnType<typeof pendingEntries>): void {
    if (key === 'j' || key === '\x1b[B') this.scroll++;
    else if (key === 'k' || key === '\x1b[A') this.scroll = Math.max(0, this.scroll - 1);
    else if (key === '\x06' || key === '\x1b[6~') this.scroll += 10;
    else if (key === '\x02' || key === '\x1b[5~') this.scroll = Math.max(0, this.scroll - 10);
    else if (key === ']c') {
      this.selection = Math.min(entries.length - 1, this.selection + 1);
      this.scroll = 0;
    } else if (key === '[c') {
      this.selection = Math.max(0, this.selection - 1);
      this.scroll = 0;
    } else if (key === 'G') {
      this.selection = entries.length - 1;
      this.scroll = 0;
    } else if (key === 'g' && this.pendingPrefix === 'g') {
      this.selection = 0;
      this.scroll = 0;
      this.pendingPrefix = '';
    } else if (key === 'g') this.pendingPrefix = 'g';
    else if (key === 'l' || key === '\x1b[C') this.selection = adjacentFile(entries, this.selection, 1);
    else if (key === 'h' || key === '\x1b[D') this.selection = adjacentFile(entries, this.selection, -1);
    else if (key === '[' || key === ']') this.pendingPrefix = key;
    else if (key === 'c' && (this.pendingPrefix === '[' || this.pendingPrefix === ']')) {
      this.selection = Math.max(
        0,
        Math.min(entries.length - 1, this.selection + (this.pendingPrefix === ']' ? 1 : -1)),
      );
      this.pendingPrefix = '';
      this.scroll = 0;
    } else this.pendingPrefix = '';
  }
}

function pendingEntries(proposal: EditProposal): { file: FileEditPlan; item: EditReviewItem }[] {
  return proposal.files.flatMap(file =>
    file.items.filter(item => item.decision === EditDecisionState.PENDING).map(item => ({ file, item })),
  );
}

function adjacentFile(entries: ReturnType<typeof pendingEntries>, current: number, direction: 1 | -1): number {
  const file = entries[current]?.file.id;
  for (let index = current + direction; index >= 0 && index < entries.length; index += direction) {
    if (entries[index]?.file.id !== file) return index;
  }
  return current;
}

function renderEntry(file: FileEditPlan, item: EditReviewItem): string {
  const title = `${file.operation} ${file.sourcePath}${file.targetPath !== file.sourcePath ? ` -> ${file.targetPath}` : ''}`;
  if (item.kind === EditReviewItemKind.CREATE) return `${title}\n[create file]\n${visible(item.insertedText, '+')}`;
  if (item.kind === EditReviewItemKind.DELETE) return `${title}\n[delete file]\n${visible(item.removedText, '-')}`;
  if (item.kind === EditReviewItemKind.RENAME)
    return `${title}\n[rename path]\n- ${file.sourcePath}\n+ ${file.targetPath}`;
  const context = surroundingContext(file.base?.text ?? '', item.sourceStart, item.sourceEnd);
  const before = context.before ? `${visible(context.before, ' ')}\n` : '';
  const after = context.after ? `\n${visible(context.after, ' ')}` : '';
  return `${title}\n@@ offset ${item.sourceStart}..${item.sourceEnd} @@\n${before}${visible(item.removedText, '-')}\n${visible(item.insertedText, '+')}${after}`;
}

function surroundingContext(text: string, start: number, end: number): { before: string; after: string } {
  const beforeLines = text.slice(0, start).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const afterLines = text.slice(end).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  return { before: beforeLines.slice(-2).join(''), after: afterLines.slice(0, 2).join('') };
}

function visible(text: string, prefix: string): string {
  if (text === '') return `${prefix} <empty>`;
  const marked = text
    .replace(/\t/g, '→   ')
    .replace(/ +(?=\r?$)/gm, spaces => '·'.repeat(spaces.length))
    .replace(/\r\n/g, '↵CRLF\n')
    .replace(/\r/g, '↵CR\n')
    .replace(/\n/g, '↵LF\n');
  const lines = marked
    .split('\n')
    .map(line => `${prefix} ${line}`)
    .join('\n');
  return /(?:\r\n|\r|\n)$/.test(text) ? lines : `${lines}\n${prefix} \\ No newline at end of file`;
}

function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(
      /[\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
