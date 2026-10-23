import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';

interface TextDocumentEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly expected_text: string;
  readonly replacement_text: string;
}

/**
 * Represents an immutable text document using VS Code-compatible, zero-based
 * UTF-16 positions. It is the single owner of coordinate conversion and exact
 * ranged-edit composition, independent of filesystem and review concerns.
 */
export class TextDocument {
  private lines: readonly { start: number; end: number }[] | undefined;

  constructor(
    private readonly path: string,
    private readonly text: string,
  ) {}

  apply(edits: readonly TextDocumentEdit[]): string {
    if (edits.length === 0) return this.text;
    const resolved = edits
      .map(edit => {
        const start = this.offsetAt(edit.range.start.line, edit.range.start.character);
        const end = this.offsetAt(edit.range.end.line, edit.range.end.character);
        if (end < start) {
          throw new EditError(EditFailureReason.INCONSISTENT, 'Edit range ends before it starts.', { path: this.path });
        }
        if (this.text.slice(start, end) !== edit.expected_text) {
          throw new EditError(EditFailureReason.INCONSISTENT, 'Edit expected_text does not match Base exactly.', {
            path: this.path,
          });
        }
        return { start, end, replacement: edit.replacement_text };
      })
      .toSorted((left, right) => left.start - right.start || left.end - right.end);

    for (let index = 1; index < resolved.length; index++) {
      const previous = resolved[index - 1]!;
      const current = resolved[index]!;
      const duplicateInsertion =
        current.start === previous.start && current.end === current.start && previous.end === previous.start;
      if (current.start < previous.end || duplicateInsertion) {
        throw new EditError(
          EditFailureReason.AMBIGUOUS,
          'Edits overlap or contain multiple insertions at the same offset.',
          { path: this.path },
        );
      }
    }

    // Every offset belongs to the immutable base. Copy each untouched span
    // once instead of rebuilding the full document for each replacement.
    const parts: string[] = [];
    let offset = 0;
    for (const edit of resolved) {
      parts.push(this.text.slice(offset, edit.start), edit.replacement);
      offset = edit.end;
    }
    parts.push(this.text.slice(offset));
    return parts.join('');
  }

  private offsetAt(line: number, character: number): number {
    if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Edit position is outside Base.', { path: this.path });
    }
    // This document never changes, so every edit endpoint can share its index.
    const range = (this.lines ??= this.lineRanges())[line];
    if (!range || character > range.end - range.start) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Edit position is outside Base.', { path: this.path });
    }
    const offset = range.start + character;
    /**
     * Fucking V8 and it's horrifically bad coverage reporting
     */
    /* v8 ignore next -- @preserve */
    if (offset > 0 && (this.text.codePointAt(offset - 1) ?? 0) > 0xffff) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Edit boundary splits a UTF-16 surrogate pair.', {
        path: this.path,
      });
    }
    return offset;
  }

  private lineRanges(): { start: number; end: number }[] {
    const result: { start: number; end: number }[] = [];
    let start = 0;
    for (let index = 0; index < this.text.length; index++) {
      if (this.text[index] !== '\n' && this.text[index] !== '\r') continue;
      result.push({ start, end: index });
      if (this.text[index] === '\r' && this.text[index + 1] === '\n') index++;
      start = index + 1;
    }
    result.push({ start, end: this.text.length });
    return result;
  }
}
