import { Schema, type Node as PromptNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import {
  schema as markdownSchema,
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import type { GlyphPromptDocument, GlyphPromptPart } from '#src/desktop/workbench/GlyphPromptDocument.js';

export const promptSchema = new Schema({
  nodes: markdownSchema.spec.nodes
    .update('heading', { ...markdownSchema.spec.nodes.get('heading')!, content: 'inline*' })
    .update('code_block', { ...markdownSchema.spec.nodes.get('code_block')!, content: 'inline*' })
    // Images stay textual; pasted Markdown must not fetch remote resources.
    .update('image', {
      ...markdownSchema.spec.nodes.get('image')!,
      toDOM: node => ['span', node.attrs.alt || node.attrs.src],
    })
    .addToEnd('attachment', {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { attachment: {} },
      toDOM: node => ['span', { 'data-glyph-attachment': 'true' }, node.attrs.attachment.path],
    }),
  marks: markdownSchema.spec.marks.update('link', {
    ...markdownSchema.spec.marks.get('link')!,
    toDOM: () => ['span', { class: 'glyph-prompt-link' }, 0],
  }),
});
const parser = new MarkdownParser(promptSchema, defaultMarkdownParser.tokenizer, defaultMarkdownParser.tokens);
const nonce = () =>
  `GLYPH${Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('')}TOKEN`;

/** Temporary text markers map Markdown offsets through nesting, escaping and atomic badges.
 * They never leave this codec, and are unique per conversion (user text cannot forge a badge).
 */
export function parsePrompt(document: GlyphPromptDocument): { doc: PromptNode; from: number; to: number } {
  const start = nonce(),
    end = nonce();
  const attachments = new Map<string, GlyphPromptPart & { type: 'attachment' }>();
  let source = '',
    offset = 0;
  for (const part of document.parts) {
    const text = part.type === 'text' ? part.text : '\ufffc';
    for (let index = 0; index < text.length; index++, offset++) {
      if (offset > 0 && offset === document.from) source += start;
      if (offset > 0 && offset === document.to) source += end;
      if (part.type === 'attachment') {
        const marker = nonce();
        attachments.set(marker, part);
        source += marker;
      } else source += text[index];
    }
  }
  if (offset > 0 && offset === document.from) source += start;
  if (offset > 0 && offset === document.to) source += end;
  const baseline = parser.parse(source.replaceAll(start, '').replaceAll(end, ''));
  const clean = EditorState.create({ doc: baseline }).tr;
  baseline.descendants((node, position) => {
    if (!node.isText) return;
    for (const [marker, part] of attachments) {
      const index = node.text!.indexOf(marker);
      if (index < 0) continue;
      const at = clean.mapping.map(position + index);
      clean.replaceWith(
        at,
        at + marker.length,
        promptSchema.nodes.attachment!.create({ attachment: part.attachment }, null, node.marks),
      );
    }
  });
  const doc = parser.parse(source);
  const transaction = EditorState.create({ doc }).tr;
  const replacements: { from: number; to: number; marker: string }[] = [];
  const pattern = new RegExp([start, end, ...attachments.keys()].join('|'), 'g');
  doc.descendants((node, position) => {
    if (!node.isText) return;
    for (const match of node.text!.matchAll(pattern))
      replacements.push({
        from: position + match.index,
        to: position + match.index + match[0].length,
        marker: match[0],
      });
  });
  let from = 1,
    to = 1;
  for (const replacement of replacements) {
    const position = transaction.mapping.map(replacement.from);
    const finish = transaction.mapping.map(replacement.to);
    const attachment = attachments.get(replacement.marker);
    if (attachment)
      transaction.replaceWith(
        position,
        finish,
        promptSchema.nodes.attachment!.create(
          { attachment: attachment.attachment },
          null,
          transaction.doc.resolve(position).marks(),
        ),
      );
    else {
      transaction.delete(position, finish);
      if (replacement.marker === start) from = position;
      else to = position;
    }
  }
  // A caret marker next to Markdown delimiters (e.g. a closing code fence)
  // must not change the meaning of the draft. Those syntax-only positions map
  // to the nearest document boundary instead.
  if (!transaction.doc.eq(clean.doc)) {
    const boundary = (position: number) => (position >= offset ? clean.doc.content.size - 1 : 1);
    return { doc: clean.doc, from: boundary(document.from), to: boundary(document.to) };
  }
  return { doc: transaction.doc, from, to };
}

export function serializePrompt(state: EditorState): GlyphPromptDocument {
  const start = nonce(),
    end = nonce();
  const attachments = new Map<string, GlyphPromptPart & { type: 'attachment' }>();
  // Insert the later marker first to keep the original document positions valid.
  const transaction = state.tr.insertText(end, state.selection.to).insertText(start, state.selection.from);
  const serializer = new MarkdownSerializer(
    {
      ...defaultMarkdownSerializer.nodes,
      attachment(output, node) {
        const marker = nonce();
        attachments.set(marker, { type: 'attachment', attachment: node.attrs.attachment });
        output.text(marker, false);
      },
      code_block(output, node) {
        const fence = '`'.repeat(
          Math.max(3, ...[...node.textContent.matchAll(/`+/g)].map(match => match[0].length + 1)),
        );
        output.write(`${fence}${node.attrs.params || ''}\n`);
        node.forEach(child => {
          if (child.isText) output.text(child.text!, false);
          else serializer.nodes.attachment!(output, child, node, 0);
        });
        output.write(`\n${fence}`);
        output.closeBlock(node);
      },
    },
    defaultMarkdownSerializer.marks,
  );
  const text = serializer.serialize(transaction.doc, { tightLists: true });
  const pattern = new RegExp([start, end, ...attachments.keys()].join('|'), 'g');
  const parts: GlyphPromptPart[] = [];
  let previous = 0,
    offset = 0,
    from = 0,
    to = 0;
  for (const match of text.matchAll(pattern)) {
    const fragment = text.slice(previous, match.index);
    if (fragment) parts.push({ type: 'text', text: fragment });
    offset += fragment.length;
    if (match[0] === start) from = offset;
    else if (match[0] === end) to = offset;
    else {
      parts.push(attachments.get(match[0])!);
      offset++;
    }
    previous = match.index + match[0].length;
  }
  if (previous < text.length) parts.push({ type: 'text', text: text.slice(previous) });
  return { parts, from, to };
}

export function promptSelection(doc: PromptNode, from: number, to: number) {
  return TextSelection.between(
    doc.resolve(Math.min(from, doc.content.size)),
    doc.resolve(Math.min(to, doc.content.size)),
  );
}
