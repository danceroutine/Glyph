import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';

/** Preserve byte-changing controls as visible evidence before terminal styling is added. */
export function renderReviewText(value: string): string {
  return sanitizeText(
    value.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\uFEFF]/gu, character => {
      const point = character.codePointAt(0)!;
      if (point < 0x20) return String.fromCodePoint(0x2400 + point);
      if (point === 0x7f) return '␡';
      return `⟨U+${point.toString(16).toUpperCase().padStart(4, '0')}⟩`;
    }),
  );
}
