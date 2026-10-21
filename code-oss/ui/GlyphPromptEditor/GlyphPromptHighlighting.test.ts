import { EditorState, TextSelection } from 'prosemirror-state';
import type { DecorationSet } from 'prosemirror-view';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { promptSchema } from '#code-oss/ui/GlyphPromptEditor/GlyphPromptMarkdown.ts';
import { glyphPromptHighlighting } from '#code-oss/ui/GlyphPromptEditor/GlyphPromptHighlighting.ts';

const highlighter = vi.hoisted(() => ({ tokens: undefined as unknown[] | undefined }));

vi.mock('#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts')>();
  return {
    highlightGlyphCode: (...args: Parameters<typeof actual.highlightGlyphCode>) =>
      highlighter.tokens ?? actual.highlightGlyphCode(...args),
  };
});

const codeDocument = (...blocks: ReturnType<typeof promptSchema.node>[]) => promptSchema.node('doc', null, blocks);

const code = (text: string, params = 'ts') =>
  promptSchema.node('code_block', { params }, text ? [promptSchema.text(text)] : []);

const decorated = (state: EditorState) => {
  const plugin = state.plugins[0]!;
  const set = plugin.getState(state) as DecorationSet;
  return set.find().map(decoration => ({
    text: state.doc.textBetween(decoration.from, decoration.to),
    classes: (decoration as unknown as { type: { attrs: { class: string } } }).type.attrs.class,
  }));
};

describe(glyphPromptHighlighting, () => {
  it('colors tokens inside code blocks only', () => {
    const doc = codeDocument(
      promptSchema.node('paragraph', null, [promptSchema.text('const outside = 1;')]),
      code('const a = "b";'),
    );

    const state = EditorState.create({ doc, plugins: [glyphPromptHighlighting()] });

    expect(decorated(state)).toEqual([
      { text: 'const', classes: 'hljs-keyword' },
      { text: '"b"', classes: 'hljs-string' },
    ]);
    expect(state.plugins[0]!.props.decorations!.call(state.plugins[0]!, state)).toBe(state.plugins[0]!.getState(state));
  });

  it('applies nested token classes together', () => {
    const doc = codeDocument(code('<a href="x">', 'html'));

    const state = EditorState.create({ doc, plugins: [glyphPromptHighlighting()] });

    expect(decorated(state)).toContainEqual({ text: '"x"', classes: 'hljs-tag hljs-string' });
  });

  it('detects the language of unlabeled code blocks', () => {
    const doc = codeDocument(code('def run():\n    return 1', ''));

    const state = EditorState.create({ doc, plugins: [glyphPromptHighlighting()] });

    expect(decorated(state).map(range => range.classes)).toContain('hljs-keyword');
  });

  it('leaves code blocks with context badges, oversized code and unknown languages uncolored', () => {
    const badge = promptSchema.node('attachment', {
      attachment: {
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///a',
        path: 'a',
        text: '',
        contentRevision: '1',
      },
    });
    const doc = codeDocument(
      promptSchema.node('code_block', { params: 'ts' }, [promptSchema.text('const a = '), badge]),
      code(`const big = "${'x'.repeat(20_001)}";`),
      code('const a = 1;', 'not-a-language'),
      code(''),
    );

    const state = EditorState.create({ doc, plugins: [glyphPromptHighlighting()] });

    expect(decorated(state)).toEqual([]);
  });

  it('skips tokens it does not understand and classes that are not lists', () => {
    highlighter.tokens = [
      { type: 'comment', value: 'ignored' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['outer'] },
        children: [
          {
            type: 'element',
            tagName: 'span',
            properties: { className: 'inner' },
            children: [{ type: 'text', value: 'ab' }],
          },
        ],
      },
    ];
    onTestFinished(() => {
      highlighter.tokens = undefined;
    });

    const state = EditorState.create({ doc: codeDocument(code('abc')), plugins: [glyphPromptHighlighting()] });

    expect(decorated(state)).toEqual([{ text: 'ab', classes: 'outer' }]);
  });

  it('keeps decorations when only the selection changes and recolors edited code', () => {
    const doc = codeDocument(code('const a = 1;'), code('let b = 2;'));
    const state = EditorState.create({ doc, plugins: [glyphPromptHighlighting()] });

    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(moved.plugins[0]!.getState(moved)).toBe(state.plugins[0]!.getState(state));

    const edited = moved.apply(moved.tr.insertText('return ', 1));
    expect(decorated(edited).map(range => range.text)).toEqual(['return', 'const', '1', 'let', '2']);
  });
});
