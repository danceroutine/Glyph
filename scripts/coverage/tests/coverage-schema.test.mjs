import { expect, it } from 'vitest';
import { coverageSchema } from '#scripts/coverage/coverage-schema.mjs';

it('reads V8 unmapped positions and JSON-encoded infinite end columns without changing hit counts', () => {
  const file = {
    path: '/repo/a.ts',
    statementMap: { 0: { start: { line: 1, column: 2 }, end: { line: 1, column: null } } },
    fnMap: {},
    branchMap: { 0: { type: 'if', line: 1, loc: { start: {}, end: {} }, locations: [] } },
    s: { 0: 3 },
    f: {},
    b: { 0: [0] },
  };
  const result = coverageSchema.parse({ '/repo/a.ts': file })['/repo/a.ts'];
  expect(result.statementMap[0]).toEqual({ start: { line: 1, column: 2 }, end: { line: 1, column: Infinity } });
  expect(result.branchMap[0].loc).toEqual({ start: { line: 0, column: 0 }, end: { line: 0, column: 0 } });
  expect(result.s).toEqual({ 0: 3 });
  expect(result.b).toEqual({ 0: [0] });
});
