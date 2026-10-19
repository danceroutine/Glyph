import { expect, it } from 'vitest';
import { parseGlyphAgentReviewFindings as parse } from '../GlyphAgentReviewFinding.ts';
const files = new Map([['src/file.ts', 8]]);
const finding = { path: 'src/file.ts', line: 2, title: 'Missing validation', body: 'Empty input causes a crash.' };
const report = (value: unknown) => `<glyph_review>\n${JSON.stringify(value)}\n{"complete":true}\n</glyph_review>`;
it('streams complete findings while waiting for the report to close', () => {
  const partial = `<glyph_review>\n${JSON.stringify(finding)}\n{"path":`;
  const first = parse(partial, files);
  expect(first.complete).toBe(false);
  expect(first.findings).toEqual([{ ...finding, id: 'src/file.ts:2:0' }]);
  expect(parse(report(finding), files)).toEqual({ findings: first.findings, complete: true });
});
it.each([
  { ...finding, path: '../outside.ts' },
  { ...finding, line: 9 },
  { ...finding, line: 0 },
  { ...finding, line: 1.5 },
  { ...finding, title: ' ' },
  { ...finding, body: 'x'.repeat(8001) },
])('rejects invalid finding records without claiming a clean review', invalid => {
  expect(parse(report(invalid), files)).toEqual({ findings: [], complete: false });
});
it('requires an explicit complete report for a clean review', () => {
  expect(parse('No issues found.', files).complete).toBe(false);
  expect(parse('<glyph_review>\n{"complete":true}\n</glyph_review>', files)).toEqual({ findings: [], complete: true });
});
