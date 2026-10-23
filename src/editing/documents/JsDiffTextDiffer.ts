import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import type { TextDiffer } from './TextDiffer.ts';

const ALGORITHM_VERSION = 'jsdiff-9.0.0-exact-lines-v1';

export class JsDiffTextDiffer implements TextDiffer {
  createReviewItems(
    fileId: string,
    base: string,
    proposed: string,
    { timeoutMs }: { timeoutMs: number },
  ): EditReviewItem[] {
    const deadline = performance.now() + timeoutMs;
    const checkBudget = (): void => {
      if (performance.now() >= deadline) throw diffBudgetExceeded();
    };
    checkBudget();
    const before = tokenize(base);
    const after = tokenize(proposed);
    checkBudget();
    const changes = diffArrays(before, after, {
      timeout: Math.max(0, deadline - performance.now()),
      // The library checks between edit distances. Also check common-prefix
      // comparisons, which can do substantial work within one distance.
      comparator: (left, right) => {
        checkBudget();
        return left === right;
      },
    });
    if (!changes) throw diffBudgetExceeded();
    const items: EditReviewItem[] = [];
    let sourceOffset = 0;
    for (let index = 0; index < changes.length;) {
      checkBudget();
      const change = changes[index];
      if (!change) break;
      if (!change.added && !change.removed) {
        sourceOffset += change.value.join('').length;
        index++;
        continue;
      }
      const start = sourceOffset;
      let removedText = '';
      let insertedText = '';
      while (index < changes.length) {
        const part = changes[index];
        if (!part || (!part.added && !part.removed)) break;
        const value = part.value.join('');
        if (part.removed) {
          removedText += value;
          sourceOffset += value.length;
        }
        if (part.added) insertedText += value;
        index++;
      }
      const id = createHash('sha256')
        .update(`${ALGORITHM_VERSION}\0${fileId}\0${start}\0${removedText}\0${insertedText}`)
        .digest('hex');
      items.push({
        id,
        fileId,
        kind: EditReviewItemKind.TEXT,
        sourceStart: start,
        sourceEnd: start + removedText.length,
        removedText,
        insertedText,
        decision: EditDecisionState.PENDING,
      });
    }
    return items;
  }
}

function diffBudgetExceeded(): EditError {
  return new EditError(EditFailureReason.LIMIT_EXCEEDED, 'Diff computation exceeded the configured time budget.');
}

function tokenize(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
}
