import { expect, it } from 'vitest';
import { assertGlyphDiagramComplexity } from '#code-oss/ui/GlyphDiagram/GlyphDiagramComplexity.ts';

it('bounds graph edges, including multiple edges expressed on one line', () => {
  const chain = Array.from({ length: 202 }, (_, i) => `N${i}`).join(' --> ');
  expect(() => assertGlyphDiagramComplexity('flowchart LR\n' + chain)).toThrow('too complex');
  expect(() => assertGlyphDiagramComplexity('flowchart LR\n' + chain.replaceAll('>', '&gt;'))).toThrow('too complex');
  expect(() => assertGlyphDiagramComplexity('flowchart LR\nA --> B')).not.toThrow();
});
it('bounds statements for the other native diagram types before layout', () => {
  expect(() => assertGlyphDiagramComplexity('classDiagram\n' + 'class A\n'.repeat(201))).toThrow('too many statements');
  expect(() => assertGlyphDiagramComplexity('sequenceDiagram\nA->>B: Message')).not.toThrow();
  expect(() => assertGlyphDiagramComplexity('graph nonsense')).not.toThrow();
});
