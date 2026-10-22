import type { Node } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { highlightGlyphCode } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts';
import { attrString } from './GlyphPromptMarkdown.ts';

type TokenNode = NonNullable<ReturnType<typeof highlightGlyphCode>>[number];
interface TokenRange {
  readonly from: number;
  readonly to: number;
  readonly classes: string;
}

/** Decorations color text without changing its content, selection, Markdown or undo history. */
export function glyphPromptHighlighting(): Plugin<DecorationSet> {
  // ProseMirror reuses unchanged nodes; typing in one block need not re-tokenize other blocks.
  const cache = new WeakMap<Node, readonly TokenRange[]>();
  const decorate = (doc: Node): DecorationSet => {
    const decorations: Decoration[] = [];
    doc.descendants((node, position) => {
      if (node.type.name !== 'code_block') return undefined;
      let ranges = cache.get(node);
      if (!ranges) {
        const result: TokenRange[] = [];
        let textOnly = true;
        node.forEach(child => {
          if (!child.isText) textOnly = false;
        });
        // Bound synchronous work while typing. Atomic context badges stay undecorated.
        const nodes =
          textOnly && node.content.size <= 20_000
            ? highlightGlyphCode(node.textContent, attrString(node, 'params'), true)
            : undefined;
        let offset = 0;
        const visit = (tokens: readonly TokenNode[], inherited: readonly string[]) => {
          for (const token of tokens) {
            if (token.type === 'text') {
              if (token.value.length > 0 && inherited.length > 0)
                result.push({ from: offset, to: offset + token.value.length, classes: inherited.join(' ') });
              offset += token.value.length;
            } else if (token.type === 'element') {
              const classes = token.properties.className;
              visit(token.children, [...inherited, ...(Array.isArray(classes) ? classes.map(String) : [])]);
            }
          }
        };
        if (nodes) visit(nodes, []);
        ranges = result;
        cache.set(node, ranges);
      }
      for (const range of ranges)
        decorations.push(
          Decoration.inline(position + 1 + range.from, position + 1 + range.to, { class: range.classes }),
        );
      return false;
    });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin<DecorationSet>({
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (transaction, previous) => (transaction.docChanged ? decorate(transaction.doc) : previous),
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
