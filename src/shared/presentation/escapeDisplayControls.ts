/** Make invisible direction and control characters visible without altering ordinary international text. */
export function escapeDisplayControls(text: string, singleLine = false): string {
  return text.replaceAll(
    /[\u0000-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/gu,
    character => {
      if (!singleLine && ['\r', '\n', '\t'].includes(character)) return character;
      return '\\u' + character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
    },
  );
}
