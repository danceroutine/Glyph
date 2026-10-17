import { Schema, type Node as PromptNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { h, render } from 'preact';
import type { GlyphPromptDocument, GlyphPromptPart } from '#src/desktop/workbench/GlyphPromptDocument.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { GlyphContextBadge } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph' },
    paragraph: { content: 'inline*', whitespace: 'pre', toDOM: () => ['div', 0] },
    text: { group: 'inline' },
    attachment: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: true,
      attrs: { attachment: {} },
      toDOM: node => ['span', { 'data-glyph-attachment': 'true' }, node.attrs.attachment.path],
    },
  },
});
export interface GlyphPromptQuery {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}
interface PromptCallbacks {
  change(document: GlyphPromptDocument): void;
  preview(attachment: GlyphContextAttachment): void;
  query(query: GlyphPromptQuery | undefined): void;
  keydown(event: KeyboardEvent): boolean;
  submit(): void;
}
function toDocument(parts: readonly GlyphPromptPart[]): PromptNode {
  return schema.node('doc', null, [
    schema.node(
      'paragraph',
      null,
      parts.flatMap(part =>
        part.type === 'text'
          ? part.text
            ? [schema.text(part.text)]
            : []
          : [schema.node('attachment', { attachment: part.attachment })],
      ),
    ),
  ]);
}
/** ProseMirror owns DOM selection, atomic badge deletion, composition and edit history. */
export class GlyphPromptEditor {
  readonly view: EditorView;
  // Workbench keybindings also listen for bubbled keydown events. A shortcut
  // already handled by this editor must not run a second command in Code OSS.
  private readonly containKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) event.stopPropagation();
  };
  constructor(
    container: HTMLElement,
    document: GlyphPromptDocument,
    private readonly callbacks: PromptCallbacks,
  ) {
    this.view = new EditorView(container, {
      state: this.state(document),
      attributes: {
        role: 'textbox',
        'aria-label': 'Message Glyph',
        'aria-multiline': 'true',
        'aria-autocomplete': 'list',
        'data-placeholder': 'Ask Glyph about this project',
      },
      nodeViews: {
        attachment: node => {
          const dom = window.document.createElement('span');
          dom.contentEditable = 'false';
          const attachment: GlyphContextAttachment = node.attrs.attachment;
          const range = attachment.range ? ` (${attachment.range.start.line}-${attachment.range.end.line})` : '';
          render(
            h(GlyphContextBadge, {
              label: `${attachment.path.split('/').at(-1)}${range}`,
              title: `${attachment.path}${range}`,
              onClick: () => callbacks.preview(attachment),
            }),
            dom,
          );
          return { dom, stopEvent: () => true, destroy: () => render(null, dom) };
        },
      },
      handleKeyDown: (_view, event) => !event.isComposing && callbacks.keydown(event),
      handlePaste: (view, event) => {
        // Clipboard HTML cannot forge trusted context badges.
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return false;
        view.dispatch(view.state.tr.insertText(text));
        return true;
      },
      dispatchTransaction: transaction => {
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        const parts: GlyphPromptPart[] = [];
        state.doc.firstChild?.forEach(node => {
          if (node.isText) parts.push({ type: 'text', text: node.text! });
          else parts.push({ type: 'attachment', attachment: node.attrs.attachment });
        });
        callbacks.change({ parts, from: state.selection.from - 1, to: state.selection.to - 1 });
        this.updateQuery();
      },
    });
    this.view.dom.addEventListener('keydown', this.containKeydown);
  }
  private state(document: GlyphPromptDocument): EditorState {
    const doc = toDocument(document.parts);
    return EditorState.create({
      doc,
      selection: TextSelection.create(
        doc,
        Math.min(document.from + 1, doc.content.size - 1),
        Math.min(document.to + 1, doc.content.size - 1),
      ),
      plugins: [
        history(),
        keymap({
          'Mod-a': (state, dispatch) => {
            dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
            return true;
          },
          'Mod-z': undo,
          Backspace: (state, dispatch) => {
            if (!state.selection.empty || state.selection.$from.nodeBefore?.type !== schema.nodes.attachment)
              return false;
            dispatch?.(state.tr.delete(state.selection.from - 1, state.selection.from));
            return true;
          },
          Delete: (state, dispatch) => {
            if (!state.selection.empty || state.selection.$from.nodeAfter?.type !== schema.nodes.attachment)
              return false;
            dispatch?.(state.tr.delete(state.selection.from, state.selection.from + 1));
            return true;
          },
          'Shift-Mod-z': redo,
          'Mod-y': redo,
          'Mod-Enter': () => {
            this.callbacks.submit();
            return true;
          },
          Enter: (state, dispatch) => {
            dispatch?.(state.tr.insertText('\n'));
            return true;
          },
        }),
        keymap(baseKeymap),
      ],
    });
  }
  update(document: GlyphPromptDocument): void {
    const doc = toDocument(document.parts);
    if (!this.view.state.doc.eq(doc)) {
      if (!document.parts.length) this.view.updateState(this.state(document));
      else {
        const transaction = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
        transaction.setSelection(
          TextSelection.create(
            transaction.doc,
            Math.min(document.from + 1, transaction.doc.content.size - 1),
            Math.min(document.to + 1, transaction.doc.content.size - 1),
          ),
        );
        this.view.updateState(this.view.state.apply(transaction));
      }
      this.updateQuery();
    }
  }
  insert(attachment: GlyphContextAttachment, query: GlyphPromptQuery): void {
    this.view.dispatch(
      closeHistory(
        this.view.state.tr
          .replaceWith(query.from, query.to, schema.node('attachment', { attachment }))
          .scrollIntoView(),
      ),
    );
    this.view.dispatch(closeHistory(this.view.state.tr));
    this.view.focus();
  }
  updateQuery(): void {
    const { selection } = this.view.state;
    const before = selection.empty
      ? selection.$from.parent.textBetween(0, selection.$from.parentOffset, '', '\ufffc')
      : '';
    const match = /(?:^|\s)@([^\s@\ufffc]*)$/.exec(before);
    this.callbacks.query(
      match ? { text: match[1]!, from: selection.from - match[1]!.length - 1, to: selection.from } : undefined,
    );
  }
  setEditable(editable: boolean): void {
    this.view.setProps({ editable: () => editable });
  }
  focus(): void {
    this.view.focus();
  }
  destroy(): void {
    this.view.dom.removeEventListener('keydown', this.containKeydown);
    this.view.destroy();
  }
}
