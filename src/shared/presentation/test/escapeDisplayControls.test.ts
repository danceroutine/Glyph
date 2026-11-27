import { expect, it } from 'vitest';
import { escapeDisplayControls } from '#src/shared/presentation/escapeDisplayControls.js';

it('reveals controls while preserving international text and source line structure', () => {
  expect(escapeDisplayControls('مرحبا café 中文\n\tcode\r\n\u202Eexec\u2066file\0')).toBe(
    'مرحبا café 中文\n\tcode\r\n\\u202Eexec\\u2066file\\u0000',
  );
  expect(escapeDisplayControls('name\n\r\t\u202Ejs', true)).toBe('name\\u000A\\u000D\\u0009\\u202Ejs');
  expect(escapeDisplayControls('normal.txt')).toBe('normal.txt');
});
