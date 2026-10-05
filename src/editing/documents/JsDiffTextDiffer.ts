import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';
import { EditDecisionState } from '../reviews/EditDecisionState.ts';
import type { EditReviewItem } from '../reviews/EditReviewItem.ts';
import { EditReviewItemKind } from '../reviews/EditReviewItemKind.ts';
import type { TextDiffer } from './TextDiffer.ts';

const ALGORITHM_VERSION = 'jsdiff-9.0.0-exact-lines-v1';

export class JsDiffTextDiffer implements TextDiffer {
  createReviewItems(fileId: string, base: string, proposed: string): EditReviewItem[] {
    const changes = diffArrays(tokenize(base), tokenize(proposed), { comparator: (left, right) => left === right });
    const items: EditReviewItem[] = [];
    let sourceOffset = 0;
    for (let index = 0; index < changes.length;) {
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
        if (part.removed) { removedText += value; sourceOffset += value.length; }
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

function tokenize(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}
