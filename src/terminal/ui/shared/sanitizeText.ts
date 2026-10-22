import { stripVTControlCharacters } from 'node:util';

/** Removes terminal controls and exposes invisible direction overrides safely. */
export function sanitizeText(value: string): string {
  return stripVTControlCharacters(value)
    .replaceAll(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '')
    .replaceAll(
      /[\u202A-\u202E\u2066-\u2069]/gu,
      character => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
    );
}
