import { expect, it } from 'vitest';
import { formatFolderContextOutline } from '#src/desktop/workbench/formatFolderContextOutline.js';

it('groups and sorts paths into an outline without duplicating ancestors', () => {
  expect(formatFolderContextOutline(['z.txt', 'src/b.ts', 'src/nested/a.ts', 'src/b.ts', 'empty/'])).toBe(
    'empty/\nsrc/\n  nested/\n    a.ts\n  b.ts\nz.txt',
  );
});
it('labels empty and truncated results and escapes line-breaking names', () => {
  expect(formatFolderContextOutline([])).toBe('(No search-visible files)');
  expect(formatFolderContextOutline(['one\ntwo.ts'], true)).toBe(
    '"one\\ntwo.ts"\n… Tree truncated at the search limit.',
  );
});
