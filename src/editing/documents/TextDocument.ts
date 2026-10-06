import { EditError } from '../errors/EditError.ts';
import { EditFailureReason } from '../errors/EditFailureReason.ts';

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
  constructor(
    private readonly path: string,
    private readonly text: string,
  ) {}

  apply(edits: readonly TextDocumentEdit[]): string {
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
      .sort((left, right) => left.start - right.start || left.end - right.end);

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

    let result = this.text;
    for (const edit of [...resolved].reverse()) {
      result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    }
    return result;
  }

  private offsetAt(line: number, character: number): number {
    const range = this.lineRanges()[line];
    if (!range || character > range.end - range.start) {
      throw new EditError(EditFailureReason.INCONSISTENT, 'Edit position is outside Base.', { path: this.path });
    }
    const offset = range.start + character;
    const before = this.text.charCodeAt(offset - 1);
    const after = this.text.charCodeAt(offset);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
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
