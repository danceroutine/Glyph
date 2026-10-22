import { glyphPromptHighlighting } from './GlyphPromptHighlighting.ts';
import {
  promptSchema as schema,
  parsePrompt,
  serializePrompt,
  promptSelection,
  attachmentOf,
} from './GlyphPromptMarkdown.ts';
import {
  inputRules,
  wrappingInputRule,
  textblockTypeInputRule,
  InputRule,
  undoInputRule,
} from 'prosemirror-inputrules';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { Slice } from 'prosemirror-model';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo, closeHistory } from 'prosemirror-history';
import { keydownHandler, keymap } from 'prosemirror-keymap';
import {
  baseKeymap,
  chainCommands,
  liftEmptyBlock,
  splitBlock,
  newlineInCode,
  createParagraphNear,
  toggleMark,
} from 'prosemirror-commands';
import { h, render } from 'preact';
import type { GlyphPromptDocument } from '#src/desktop/workbench/GlyphPromptDocument.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { GlyphContextBadge } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';

export interface GlyphPromptQuery {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}
interface PromptCallbacks {
  change(document: GlyphPromptDocument): void;
  preview(attachment: GlyphContextAttachment): void;
  describe?(attachment: GlyphContextAttachment): Promise<string | undefined>;
  query(query: GlyphPromptQuery | undefined): void;
  keydown(event: KeyboardEvent): boolean;
  submit(): void;
  steer?(): void;
  readonly nativeKeybindings?: boolean;
}
/** ProseMirror owns DOM selection, atomic badge deletion, composition and edit history. */
export class GlyphPromptEditor {
  readonly view: EditorView;
  private lastDocument: GlyphPromptDocument | undefined;
  // Workbench keybindings also listen for bubbled keydown events. A shortcut
  // already handled by this editor must not run a second command in Code OSS.
  private readonly containKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) event.stopPropagation();
  };
  private readonly historyKeydown = keydownHandler({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo });
  private readonly newline = chainCommands(
    (state, dispatch) => {
      const { $from, empty } = state.selection;
      const match = /^```([\w-]*)$/u.exec($from.parent.textContent);
      if (!empty || $from.parent.type !== schema.nodes.paragraph || !match) return false;
      dispatch?.(
        state.tr
          .delete($from.start(), $from.end())
          .setBlockType($from.start(), $from.start(), schema.nodes.code_block!, { params: match[1] }),
      );
      return true;
    },
    newlineInCode,
    splitListItem(schema.nodes.list_item!),
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
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
        'data-placeholder': 'Plan, build, @ for context',
      },
      nodeViews: {
        attachment: node => {
          const dom = window.document.createElement('span');
          dom.contentEditable = 'false';
          const attachment = attachmentOf(node);
          const range = attachment.range ? ` (${attachment.range.start.line}-${attachment.range.end.line})` : '';
          const title = `${attachment.path}${range}${attachment.unavailable !== undefined && attachment.unavailable !== '' ? `\n${attachment.unavailable}` : ''}`;
          let disposed = false;
          const describe = () => {
            void callbacks
              .describe?.(attachment)
              .then(status => {
                const button = dom.querySelector('button');
                if (!disposed && button)
                  button.title =
                    status !== undefined &&
                    status !== '' &&
                    (attachment.unavailable === undefined || attachment.unavailable === '')
                      ? `${title}\n${status}`
                      : title;
              })
              .catch(() => {});
          };
          dom.addEventListener('mouseenter', describe);
          dom.addEventListener('focusin', describe);
          render(
            h(GlyphContextBadge, {
              label: `${attachment.path.split('/').at(-1)}${range}${attachment.unavailable !== undefined && attachment.unavailable !== '' ? ' (unavailable)' : ''}`,
              title,
              actionLabel: ['file', 'selection', 'folder'].includes(attachment.kind) ? 'Preview' : 'Open',
              onClick: () => {
                callbacks.preview(attachment);
              },
            }),
            dom,
          );
          return {
            dom,
            stopEvent: () => true,
            destroy: () => {
              disposed = true;
              render(null, dom);
            },
          };
        },
      },
      handleKeyDown: (view, event) =>
        !event.isComposing && (this.historyKeydown(view, event) || callbacks.keydown(event)),
      handlePaste: (view, event) => {
        // Clipboard HTML cannot forge trusted context badges.
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return false;
        if (view.state.selection.$from.parent.type.spec.code === true || !/[\n*`_>#[\]]/u.test(text)) {
          view.dispatch(view.state.tr.insertText(text));
          return true;
        }
        const parsed = parsePrompt({ parts: [{ type: 'text', text }], from: text.length, to: text.length });
        view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(parsed.doc.content)).scrollIntoView());
        return true;
      },
      dispatchTransaction: transaction => {
        const state = this.view.state.apply(transaction);
        this.view.updateState(state);
        this.lastDocument = serializePrompt(state);
        callbacks.change(this.lastDocument);
        this.updateQuery();
      },
    });
    this.view.dom.addEventListener('keydown', this.containKeydown);
  }
  insertNewline(): void {
    if (this.view.editable && !this.view.composing) this.newline(this.view.state, this.view.dispatch, this.view);
  }
  update(document: GlyphPromptDocument): void {
    if (this.lastDocument && JSON.stringify(document.parts) === JSON.stringify(this.lastDocument.parts)) return;
    const { doc, from, to } = parsePrompt(document);
    if (!this.view.state.doc.eq(doc)) {
      if (document.parts.length === 0) this.view.updateState(this.state(document));
      else {
        const transaction = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
        transaction.setSelection(promptSelection(transaction.doc, from, to));
        this.view.updateState(this.view.state.apply(transaction));
      }
      this.updateQuery();
    }
    this.lastDocument = document;
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
      ? selection.$from.parent.textBetween(0, selection.$from.parentOffset, '', '\uFFFC')
      : '';
    const match = /(?:^|\s)@([^\s@\uFFFC]*)$/u.exec(before);
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
  private leaveCodeBlock(direction: -1 | 1): Command {
    return (state, dispatch) => {
      if (!(state.selection instanceof TextSelection)) return false;
      const { $cursor } = state.selection;
      if (
        !$cursor ||
        $cursor.parent.type !== schema.nodes.code_block ||
        $cursor.parentOffset !== (direction === -1 ? 0 : $cursor.parent.content.size)
      )
        return false;

      const paragraph = schema.nodes.paragraph!;
      const transaction = state.tr;
      const boundary = direction === -1 ? $cursor.before() : $cursor.after();
      const adjacent = direction === -1 ? state.doc.resolve(boundary).nodeBefore : state.doc.nodeAt(boundary);
      let position = direction === -1 ? boundary - 1 : boundary + 1;
      // Reuse the adjacent paragraph; otherwise create one on the requested side.
      if (adjacent?.type !== paragraph) {
        transaction.insert(boundary, paragraph.create());
        position = boundary + 1;
      }
      dispatch?.(transaction.setSelection(TextSelection.create(transaction.doc, position)).scrollIntoView());
      return true;
    };
  }
  private state(document: GlyphPromptDocument): EditorState {
    const { doc, from, to } = parsePrompt(document);
    return EditorState.create({
      doc,
      selection: promptSelection(doc, from, to),
      plugins: [
        history(),
        glyphPromptHighlighting(),
        inputRules({
          rules: [
            wrappingInputRule(/^\s*>\s$/u, schema.nodes.blockquote!),
            wrappingInputRule(/^\s*([-+*])\s$/u, schema.nodes.bullet_list!, { tight: true }),
            wrappingInputRule(
              /^(\d+)\.\s$/u,
              schema.nodes.ordered_list!,
              match => ({ order: +match[1]!, tight: true }),
              (match, node) => node.childCount + node.attrs.order === +match[1]!,
            ),
            textblockTypeInputRule(/^(#{1,6})\s$/u, schema.nodes.heading!, match => ({ level: match[1]!.length })),
            textblockTypeInputRule(/^```([\w-]*)\s$/u, schema.nodes.code_block!, match => ({ params: match[1] })),
            new InputRule(/\[([^\]]+)\]\(([^()\s]+)\)$/u, (state, match, start, end) => {
              const transaction = state.tr.replaceWith(
                start,
                end,
                schema.text(match[1]!, [schema.marks.link!.create({ href: match[2] })]),
              );
              transaction.removeStoredMark(schema.marks.link!);
              return transaction;
            }),
            ...(
              [
                ['strong', /\*\*([^*]+)\*\*$/u],
                ['strong', /__([^_]+)__$/u],
                ['em', /(?:^|\s)_([^_]+)_$/u],
                ['em', /(?:^|\s)\*([^*]+)\*$/u],
                ['code', /`([^`]+)`$/u],
              ] as const
            ).map(
              ([mark, pattern]) =>
                new InputRule(pattern, (state, match, start, end) => {
                  const content = match[1]!;
                  const prefix = match[0].startsWith(' ') ? 1 : 0;
                  const transaction = state.tr.replaceWith(
                    start + prefix,
                    end,
                    schema.text(content, [schema.marks[mark]!.create()]),
                  );
                  transaction.removeStoredMark(schema.marks[mark]!);
                  return transaction;
                }),
            ),
          ],
        }),
        keymap({
          ArrowDown: this.leaveCodeBlock(1),
          ArrowRight: this.leaveCodeBlock(1),
          ArrowUp: this.leaveCodeBlock(-1),
          ArrowLeft: this.leaveCodeBlock(-1),
          'Mod-a': (state, dispatch) => {
            dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
            return true;
          },
          Backspace: chainCommands(undoInputRule, (state, dispatch) => {
            if (!state.selection.empty || state.selection.$from.nodeBefore?.type !== schema.nodes.attachment)
              return false;
            dispatch?.(state.tr.delete(state.selection.from - 1, state.selection.from));
            return true;
          }),
          Delete: (state, dispatch) => {
            if (!state.selection.empty || state.selection.$from.nodeAfter?.type !== schema.nodes.attachment)
              return false;
            dispatch?.(state.tr.delete(state.selection.from, state.selection.from + 1));
            return true;
          },
          ...(this.callbacks.nativeKeybindings === true
            ? {}
            : {
                'Mod-Enter': () => {
                  this.callbacks.steer?.();
                  return true;
                },
              }),
          'Mod-b': toggleMark(schema.marks.strong!),
          'Mod-i': toggleMark(schema.marks.em!),
          Tab: chainCommands(sinkListItem(schema.nodes.list_item!), (state, dispatch) => {
            if (state.selection.$from.parent.type !== schema.nodes.code_block) return false;
            dispatch?.(state.tr.insertText('  '));
            return true;
          }),
          'Shift-Tab': liftListItem(schema.nodes.list_item!),
          ...(this.callbacks.nativeKeybindings === true
            ? {}
            : {
                Enter: () => {
                  this.callbacks.submit();
                  return true;
                },
              }),
          ...(this.callbacks.nativeKeybindings === true ? {} : { 'Shift-Enter': this.newline }),
        }),
        keymap(baseKeymap),
      ],
    });
  }
}
