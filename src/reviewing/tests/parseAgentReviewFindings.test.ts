import { describe, expect, it } from 'vitest';
import { parseAgentReviewFindings, type AgentReviewFileLines } from '#src/reviewing/parseAgentReviewFindings.js';

function files(): ReadonlyMap<string, AgentReviewFileLines> {
  return new Map([['file.ts', { original: 10, modified: 10, defaultSide: 'modified' as const }]]);
}

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe(parseAgentReviewFindings, () => {
  it('returns complete findings from a well-formed report', () => {
    const text = `<glyph_review>\n${line({ path: 'file.ts', line: 2, title: 'Bug', body: 'Breaks.' })}\n{"complete":true}\n</glyph_review>`;

    expect(parseAgentReviewFindings(text, files())).toEqual({
      findings: [{ id: 'file.ts:2:0', path: 'file.ts', line: 2, side: 'modified', title: 'Bug', body: 'Breaks.' }],
      complete: true,
    });
  });

  it.each([
    ['a line that is not JSON', 'not json'],
    ['a JSON value that is not an object', '42'],
    ['a null record', 'null'],
    ['a record without a string path', line({ path: 7, line: 1, title: 'Bug', body: 'Breaks.' })],
  ])('marks the report incomplete when it contains %s', (_case, invalid) => {
    const text = `<glyph_review>\n${invalid}\n${line({ path: 'file.ts', line: 1, title: 'Bug', body: 'Breaks.' })}\n{"complete":true}\n</glyph_review>`;

    const result = parseAgentReviewFindings(text, files());

    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(1);
  });

  it('rejects records that follow the completion record', () => {
    const text = `<glyph_review>\n{"complete":true}\n${line({ path: 'file.ts', line: 1, title: 'Late', body: 'After completion.' })}\n</glyph_review>`;

    expect(parseAgentReviewFindings(text, files())).toEqual({ findings: [], complete: false });
  });

  it('keeps at most one hundred findings and marks larger reports incomplete', () => {
    const records = Array.from({ length: 101 }, (_, index) =>
      line({ path: 'file.ts', line: 1, title: `Finding ${index}`, body: 'Breaks.' }),
    );
    const text = `<glyph_review>\n${records.join('\n')}\n{"complete":true}\n</glyph_review>`;

    const result = parseAgentReviewFindings(text, files());

    expect(result.complete).toBe(false);
    expect(result.findings).toHaveLength(100);
    expect(result.findings.at(-1)?.title).toBe('Finding 99');
  });

  it('treats text without a report as incomplete', () => {
    expect(parseAgentReviewFindings('No report here.', files())).toEqual({ findings: [], complete: false });
  });
});
