import { describe, expect, it } from 'vitest';
import { highlightGlyphCode } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts';

const classesOf = (nodes: ReturnType<typeof highlightGlyphCode>): string[] =>
  (nodes ?? []).flatMap(node =>
    node.type === 'element' ? [...(node.properties.className as string[]), ...classesOf(node.children as never)] : [],
  );

describe(highlightGlyphCode, () => {
  it('highlights code in the language named by the first word of its info string', () => {
    const nodes = highlightGlyphCode('const a = 1;', '  TypeScript title="example"');

    expect(classesOf(nodes)).toContain('hljs-keyword');
  });

  it('highlights JSX and TSX as their base languages', () => {
    expect(classesOf(highlightGlyphCode('const a = <b />;', 'jsx'))).toContain('hljs-keyword');
    expect(classesOf(highlightGlyphCode('const a: number = 1;', 'tsx'))).toContain('hljs-keyword');
  });

  it('leaves code in unknown languages unhighlighted', () => {
    expect(highlightGlyphCode('const a = 1;', 'not-a-language', true)).toBeUndefined();
  });

  it('detects the language of unlabeled code only when asked to', () => {
    expect(highlightGlyphCode('def run():\n    return 1', undefined)).toBeUndefined();
    expect(highlightGlyphCode('def run():\n    return 1', '')).toBeUndefined();
    expect(classesOf(highlightGlyphCode('def run():\n    return 1', undefined, true))).toContain('hljs-keyword');
    expect(classesOf(highlightGlyphCode('def run():\n    return 1', '   ', true))).toContain('hljs-keyword');
  });

  it('leaves code unhighlighted when its grammar fails', () => {
    expect(highlightGlyphCode(42 as unknown as string, 'typescript')).toBeUndefined();
  });
});
