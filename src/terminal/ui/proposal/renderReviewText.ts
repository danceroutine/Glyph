import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';

/** Preserve byte-changing controls as visible evidence before terminal styling is added. */
export function renderReviewText(value: string): string {
  return sanitizeText(
    value.replaceAll(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F\uFEFF]/gu, character => {
      const point = character.codePointAt(0)!;
      if (point < 0x20) return String.fromCodePoint(0x2400 + point);
      if (point === 0x7f) return '␡';
      return `⟨U+${point.toString(16).toUpperCase().padStart(4, '0')}⟩`;
    }),
  );
}
