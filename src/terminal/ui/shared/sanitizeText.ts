import { stripVTControlCharacters } from 'node:util';

/** Removes terminal controls and exposes invisible direction overrides safely. */
export function sanitizeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(
      /[\u202a-\u202e\u2066-\u2069]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
