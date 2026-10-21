import { DOMSerializer } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import {
  parsePrompt,
  promptSchema,
  promptSelection,
  serializePrompt,
} from '#code-oss/ui/GlyphPromptEditor/GlyphPromptMarkdown.ts';

const attachment = (overrides: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment => ({
  kind: GlyphContextAttachmentKind.FILE,
  uri: 'file:///repo/src/app.ts',
  path: 'src/app.ts',
  text: 'const a = 1;',
  contentRevision: '1',
  ...overrides,
});

const roundTrip = (document: Parameters<typeof parsePrompt>[0]) => {
  const { doc, from, to } = parsePrompt(document);
  return serializePrompt(EditorState.create({ doc, selection: promptSelection(doc, from, to) }));
};

const html = (node: ReturnType<typeof promptSchema.node>) => {
  const host = document.createElement('div');
  host.append(DOMSerializer.fromSchema(promptSchema).serializeFragment(node.content));
  return host.innerHTML;
};

describe(parsePrompt, () => {
  it('parses markdown text with the caret at the given source offset', () => {
    const { doc, from, to } = parsePrompt({ parts: [{ type: 'text', text: '**Hi** there' }], from: 4, to: 4 });

    expect(doc.firstChild?.type.name).toBe('paragraph');
    expect(doc.textContent).toBe('Hi there');
    expect(doc.firstChild?.firstChild?.marks.map(mark => mark.type.name)).toEqual(['strong']);
    expect(doc.textBetween(1, from)).toBe('Hi');
    expect(to).toBe(from);
  });

  it('places a selection that spans to the end of the text', () => {
    const { doc, from, to } = parsePrompt({ parts: [{ type: 'text', text: 'hello world' }], from: 6, to: 11 });

    expect(doc.textBetween(from, to)).toBe('world');
  });

  it('starts with the caret at the beginning when the selection starts there', () => {
    const { from, to } = parsePrompt({ parts: [{ type: 'text', text: 'hello' }], from: 0, to: 0 });

    expect([from, to]).toEqual([1, 1]);
  });

  it('parses an empty prompt', () => {
    const { doc, from, to } = parsePrompt({ parts: [], from: 0, to: 0 });

    expect(doc.textContent).toBe('');
    expect([from, to]).toEqual([1, 1]);
  });

  it('turns attachments into atomic badges that keep surrounding marks', () => {
    const file = attachment();
    const { doc } = parsePrompt({
      parts: [
        { type: 'text', text: 'See **' },
        { type: 'attachment', attachment: file },
        { type: 'text', text: '** now' },
      ],
      from: 0,
      to: 0,
    });

    const badges: { attachment: unknown; marks: string[] }[] = [];
    doc.descendants(node => {
      if (node.type.name === 'attachment')
        badges.push({ attachment: node.attrs.attachment, marks: node.marks.map(mark => mark.type.name) });
    });
    expect(badges).toEqual([{ attachment: file, marks: ['strong'] }]);
  });

  it('keeps attachments when a caret beside markdown syntax would change the meaning', () => {
    const file = attachment();
    const text = '```\ncode ';
    const parts = [
      { type: 'text' as const, text },
      { type: 'attachment' as const, attachment: file },
      { type: 'text' as const, text: '\n```' },
    ];
    const end = text.length + 1 + 4;

    const { doc, from, to } = parsePrompt({ parts, from: end, to: end });

    expect(doc.firstChild?.type.name).toBe('code_block');
    expect(doc.firstChild?.childCount).toBe(2);
    expect(doc.firstChild?.lastChild?.type.name).toBe('attachment');
    expect([from, to]).toEqual([doc.content.size - 1, doc.content.size - 1]);
  });

  it('moves a caret inside markdown syntax to the start of the prompt', () => {
    const { doc, from, to } = parsePrompt({ parts: [{ type: 'text', text: '```\ncode\n```' }], from: 1, to: 2 });

    expect(doc.firstChild?.type.name).toBe('code_block');
    expect([from, to]).toEqual([1, 1]);
  });
});

describe(serializePrompt, () => {
  it('serializes markdown, attachments and the selection, splitting text at the selection', () => {
    const file = attachment();

    expect(
      roundTrip({
        parts: [
          { type: 'text', text: '**Hi** ' },
          { type: 'attachment', attachment: file },
          { type: 'text', text: ' ok' },
        ],
        from: 9,
        to: 11,
      }),
    ).toEqual({
      parts: [
        { type: 'text', text: '**Hi** ' },
        { type: 'attachment', attachment: file },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'ok' },
      ],
      from: 9,
      to: 11,
    });
  });

  it('serializes a prompt that ends with an attachment', () => {
    const file = attachment();

    expect(roundTrip({ parts: [{ type: 'attachment', attachment: file }], from: 1, to: 1 })).toEqual({
      parts: [{ type: 'attachment', attachment: file }],
      from: 1,
      to: 1,
    });
  });

  it('fences code blocks longer than any backtick run they contain', () => {
    const plain = roundTrip({ parts: [{ type: 'text', text: '```\nplain\n```' }], from: 0, to: 0 });
    const ticks = roundTrip({ parts: [{ type: 'text', text: '````ts\nuse ``` here\n````' }], from: 0, to: 0 });

    expect(plain).toEqual({
      parts: [
        { type: 'text', text: '```\n' },
        { type: 'text', text: 'plain\n```' },
      ],
      from: 4,
      to: 4,
    });
    expect(ticks.parts.map(part => (part.type === 'text' ? part.text : '')).join('')).toBe(
      '````ts\nuse ``` here\n````',
    );
  });

  it('serializes attachments inside code blocks', () => {
    const file = attachment();
    const code = promptSchema.node('code_block', { params: 'ts' }, [
      promptSchema.text('log('),
      promptSchema.node('attachment', { attachment: file }),
      promptSchema.text(')'),
    ]);
    const doc = promptSchema.node('doc', null, [code]);

    expect(serializePrompt(EditorState.create({ doc, selection: TextSelection.create(doc, 1) }))).toEqual({
      parts: [
        { type: 'text', text: '```ts\n' },
        { type: 'text', text: 'log(' },
        { type: 'attachment', attachment: file },
        { type: 'text', text: ')\n```' },
      ],
      from: 6,
      to: 6,
    });
  });
});

describe(promptSelection, () => {
  it('clamps positions to the document', () => {
    const doc = promptSchema.node('doc', null, [promptSchema.node('paragraph', null, [promptSchema.text('abc')])]);

    const selection = promptSelection(doc, 2, 99);

    expect([selection.from, selection.to]).toEqual([2, 4]);
  });
});

describe('promptSchema', () => {
  it('renders images as text, links as plain spans and attachments by path', () => {
    const file = attachment();
    const doc = promptSchema.node('doc', null, [
      promptSchema.node('paragraph', null, [
        promptSchema.node('image', { src: 'https://example.com/a.png', alt: 'Diagram' }),
        promptSchema.node('image', { src: 'https://example.com/b.png', alt: '' }),
        promptSchema.text('docs', [promptSchema.marks.link!.create({ href: 'https://example.com' })]),
        promptSchema.node('attachment', { attachment: file }),
      ]),
    ]);

    expect(html(doc)).toBe(
      '<p><span>Diagram</span><span>https://example.com/b.png</span><span class="glyph-prompt-link">docs</span><span data-glyph-attachment="true">src/app.ts</span></p>',
    );
  });
});
