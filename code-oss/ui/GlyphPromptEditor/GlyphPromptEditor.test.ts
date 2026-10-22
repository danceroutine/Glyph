import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { GlyphPromptDocument } from '#src/desktop/workbench/GlyphPromptDocument.js';
import { GlyphPromptEditor } from '#code-oss/ui/GlyphPromptEditor/GlyphPromptEditor.ts';
import { promptSchema, serializePrompt } from '#code-oss/ui/GlyphPromptEditor/GlyphPromptMarkdown.ts';

const mod = /Mac|iPhone|iPad/u.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

const attachment = (overrides: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment => ({
  kind: GlyphContextAttachmentKind.FILE,
  uri: 'file:///repo/src/app.ts',
  path: 'src/app.ts',
  text: 'const a = 1;',
  contentRevision: '1',
  ...overrides,
});

const promptCallbacks = (overrides: Partial<ConstructorParameters<typeof GlyphPromptEditor>[2]> = {}) => ({
  change: vi.fn(),
  preview: vi.fn(),
  query: vi.fn(),
  keydown: vi.fn((_event: KeyboardEvent) => false),
  submit: vi.fn(),
  ...overrides,
});

const mountEditor = (
  prompt?: GlyphPromptDocument,
  callbacks: ConstructorParameters<typeof GlyphPromptEditor>[2] = promptCallbacks(),
) => {
  const container = document.createElement('div');
  document.body.append(container);
  const editor = new GlyphPromptEditor(container, prompt ?? { parts: [], from: 0, to: 0 }, callbacks);
  onTestFinished(() => {
    editor.destroy();
    container.remove();
  });
  return { editor, container };
};

const type = (editor: GlyphPromptEditor, text: string) => {
  for (const character of text) {
    const { from, to } = editor.view.state.selection;
    const handled = editor.view.someProp('handleTextInput', handler =>
      handler(editor.view, from, to, character, () => editor.view.state.tr.insertText(character, from, to)),
    );
    if (handled !== true) editor.view.dispatch(editor.view.state.tr.insertText(character, from, to));
  }
};

const press = (editor: GlyphPromptEditor, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  editor.view.dom.dispatchEvent(event);
  return event;
};

const markdown = (editor: GlyphPromptEditor) =>
  serializePrompt(editor.view.state)
    .parts.map(part => (part.type === 'text' ? part.text : `[${part.attachment.path}]`))
    .join('');

const select = (editor: GlyphPromptEditor, from: number, to = from) => {
  editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, from, to)));
};

const blocks = (editor: GlyphPromptEditor) => {
  const names: string[] = [];
  editor.view.state.doc.forEach(node => {
    names.push(node.type.name);
  });
  return names;
};

describe(GlyphPromptEditor, () => {
  it('renders an accessible multiline prompt', () => {
    const { editor, container } = mountEditor({ parts: [{ type: 'text', text: 'Hello' }], from: 5, to: 5 });

    const textbox = container.querySelector<HTMLElement>('[role="textbox"]')!;
    expect(textbox).toBe(editor.view.dom);
    expect(textbox.getAttribute('aria-label')).toBe('Message Glyph');
    expect(textbox.getAttribute('aria-multiline')).toBe('true');
    expect(textbox.getAttribute('aria-autocomplete')).toBe('list');
    expect(textbox.dataset.placeholder).toBe('Plan, build, @ for context');
    expect(textbox.textContent).toBe('Hello');
  });

  it('reports each change as a prompt document', () => {
    const callbacks = promptCallbacks();
    const { editor } = mountEditor(undefined, callbacks);

    type(editor, 'hi');

    expect(callbacks.change).toHaveBeenLastCalledWith({ parts: [{ type: 'text', text: 'hi' }], from: 2, to: 2 });
  });

  it('reports the context query typed after an @ and clears it afterwards', () => {
    const callbacks = promptCallbacks();
    const { editor } = mountEditor(undefined, callbacks);

    type(editor, 'see @ap');
    expect(callbacks.query).toHaveBeenLastCalledWith({ text: 'ap', from: 5, to: 8 });

    type(editor, ' ');
    expect(callbacks.query).toHaveBeenLastCalledWith(undefined);

    type(editor, '@');
    select(editor, 1, 4);
    expect(callbacks.query).toHaveBeenLastCalledWith(undefined);
  });

  it('replaces the query with an attachment and focuses the prompt', () => {
    const callbacks = promptCallbacks();
    const { editor } = mountEditor(undefined, callbacks);
    type(editor, 'see @ap');
    const file = attachment();

    editor.insert(file, { text: 'ap', from: 5, to: 8 });

    expect(callbacks.change).toHaveBeenLastCalledWith({
      parts: [
        { type: 'text', text: 'see ' },
        { type: 'attachment', attachment: file },
      ],
      from: 5,
      to: 5,
    });
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('shows attachments as badges that preview their context', () => {
    const callbacks = promptCallbacks();
    const file = attachment({ range: { start: { line: 3, column: 0 }, end: { line: 9, column: 1 } } });
    const { editor } = mountEditor({ parts: [{ type: 'attachment', attachment: file }], from: 1, to: 1 }, callbacks);

    const badge = editor.view.dom.querySelector('button')!;
    expect(badge.parentElement?.contentEditable).toBe('false');
    expect(badge.textContent).toContain('app.ts (3-9)');
    expect(badge.getAttribute('title')).toBe('src/app.ts (3-9)');
    expect(badge.getAttribute('aria-label')).toBe('Preview src/app.ts (3-9)');

    badge.click();

    expect(callbacks.preview).toHaveBeenCalledWith(file);
  });

  it('offers to open attachments that are not files, selections or folders', () => {
    const { editor } = mountEditor({
      parts: [{ type: 'attachment', attachment: attachment({ kind: GlyphContextAttachmentKind.DIAGNOSTIC }) }],
      from: 1,
      to: 1,
    });

    expect(editor.view.dom.querySelector('button')?.getAttribute('aria-label')).toBe('Open src/app.ts');
  });

  it('marks unavailable attachments and keeps their reason in the title', async () => {
    const describeAttachment = vi.fn(async () => 'Edited since capture');
    const { editor } = mountEditor(
      {
        parts: [{ type: 'attachment', attachment: attachment({ unavailable: 'Outside the workspace' }) }],
        from: 1,
        to: 1,
      },
      promptCallbacks({ describe: describeAttachment }),
    );
    const badge = editor.view.dom.querySelector('button')!;

    badge.parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => {
      expect(describeAttachment).toHaveBeenCalled();
    });
    await Promise.resolve();

    expect(badge.textContent).toContain('app.ts (unavailable)');
    expect(badge.title).toBe('src/app.ts\nOutside the workspace');
  });

  it('describes the current status of an attachment on hover or focus', async () => {
    const describeAttachment = vi.fn().mockResolvedValueOnce('Edited since capture').mockResolvedValueOnce(undefined);
    const { editor } = mountEditor(
      { parts: [{ type: 'attachment', attachment: attachment() }], from: 1, to: 1 },
      promptCallbacks({ describe: describeAttachment }),
    );
    const badge = editor.view.dom.querySelector('button')!;

    badge.parentElement!.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => {
      expect(badge.title).toBe('src/app.ts\nEdited since capture');
    });

    badge.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await vi.waitFor(() => {
      expect(badge.title).toBe('src/app.ts');
    });
  });

  it('ignores status descriptions that fail, arrive after removal or are unavailable', async () => {
    let finish!: (status: string) => void;
    const describeAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            finish = resolve;
          }),
      );
    const { editor } = mountEditor(
      { parts: [{ type: 'attachment', attachment: attachment() }], from: 1, to: 1 },
      promptCallbacks({ describe: describeAttachment }),
    );
    const host = editor.view.dom.querySelector('button')!.parentElement!;

    host.dispatchEvent(new MouseEvent('mouseenter'));
    await vi.waitFor(() => {
      expect(describeAttachment).toHaveBeenCalledOnce();
    });
    host.dispatchEvent(new MouseEvent('mouseenter'));
    editor.update({ parts: [{ type: 'text', text: 'gone' }], from: 4, to: 4 });
    finish('late');
    await Promise.resolve();

    expect(host.querySelector('button')).toBeNull();
    expect(editor.view.dom.textContent).toBe('gone');
  });

  it('keeps interaction with a badge away from the prompt', () => {
    const callbacks = promptCallbacks();
    const { editor } = mountEditor(
      { parts: [{ type: 'attachment', attachment: attachment() }], from: 1, to: 1 },
      callbacks,
    );

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    editor.view.dom.querySelector('button')!.dispatchEvent(event);

    expect(callbacks.keydown).not.toHaveBeenCalled();
    expect(callbacks.submit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('works without a host that describes attachments', () => {
    const { editor } = mountEditor({ parts: [{ type: 'attachment', attachment: attachment() }], from: 1, to: 1 });

    expect(() =>
      editor.view.dom.querySelector('button')!.parentElement!.dispatchEvent(new MouseEvent('mouseenter')),
    ).not.toThrow();
  });

  it('lets the host handle keys first and contains handled keys', () => {
    const keydown = vi.fn((event: KeyboardEvent) => event.key === 'ArrowDown');
    const { editor, container } = mountEditor(undefined, promptCallbacks({ keydown }));
    const outer = vi.fn((_event: Event) => undefined);
    container.addEventListener('keydown', outer);

    const handled = press(editor, 'ArrowDown');
    const ignored = press(editor, 'x');
    const composing = press(editor, 'ArrowDown', { isComposing: true });

    expect(handled.defaultPrevented).toBe(true);
    expect(ignored.defaultPrevented).toBe(false);
    expect(keydown).toHaveBeenCalledTimes(2);
    expect(outer.mock.calls.map(([event]) => event)).toEqual([ignored, composing]);
  });

  it('submits with Enter, steers with Mod-Enter and adds a line with Shift-Enter', () => {
    const callbacks = promptCallbacks({ steer: vi.fn() });
    const { editor } = mountEditor({ parts: [{ type: 'text', text: 'ab' }], from: 1, to: 1 }, callbacks);

    press(editor, 'Enter');
    press(editor, 'Enter', mod);
    press(editor, 'Enter', { shiftKey: true });

    expect(callbacks.submit).toHaveBeenCalledOnce();
    expect(callbacks.steer).toHaveBeenCalledOnce();
    expect(markdown(editor)).toBe('a\n\nb');
  });

  it('accepts Mod-Enter without a way to steer', () => {
    const { editor } = mountEditor();

    expect(press(editor, 'Enter', mod).defaultPrevented).toBe(true);
  });

  it('leaves Enter and Mod-Enter to native keybindings', () => {
    const callbacks = promptCallbacks({ nativeKeybindings: true, steer: vi.fn() });
    const { editor } = mountEditor({ parts: [{ type: 'text', text: 'ab' }], from: 1, to: 1 }, callbacks);

    press(editor, 'Enter');
    press(editor, 'Enter', mod);
    press(editor, 'Enter', { shiftKey: true });

    expect(callbacks.submit).not.toHaveBeenCalled();
    expect(callbacks.steer).not.toHaveBeenCalled();
    expect(blocks(editor)).toEqual(['paragraph', 'paragraph']);
  });

  it('selects all text, toggles marks and undoes or redoes edits from the keyboard', () => {
    const { editor } = mountEditor();
    type(editor, 'word');

    press(editor, 'a', mod);
    expect(editor.view.state.selection.from).toBe(1);
    expect(editor.view.state.selection.to).toBe(5);

    press(editor, 'b', mod);
    expect(markdown(editor)).toBe('**word**');
    press(editor, 'i', mod);
    expect(markdown(editor)).toBe('***word***');

    press(editor, 'z', mod);
    expect(markdown(editor)).toBe('**word**');
    press(editor, 'z', { ...mod, shiftKey: true });
    expect(markdown(editor)).toBe('***word***');
    press(editor, 'z', mod);
    press(editor, 'y', mod);
    expect(markdown(editor)).toBe('***word***');
  });

  it('undoes and redoes its own edits before offering those shortcuts to the workbench', () => {
    const keydown = vi.fn((event: KeyboardEvent) => event.metaKey || event.ctrlKey);
    const { editor } = mountEditor(
      {
        parts: [
          { type: 'text', text: 'a' },
          { type: 'attachment', attachment: attachment() },
          { type: 'text', text: 'b' },
        ],
        from: 2,
        to: 2,
      },
      promptCallbacks({ keydown }),
    );

    press(editor, 'Backspace');
    expect(markdown(editor)).toBe('ab');
    keydown.mockClear();
    press(editor, 'z', mod);
    expect(markdown(editor)).toBe('a[src/app.ts]b');
    press(editor, 'z', { ...mod, shiftKey: true });
    expect(markdown(editor)).toBe('ab');
    press(editor, 'z', mod);
    press(editor, 'y', mod);
    expect(markdown(editor)).toBe('ab');
    expect(keydown).not.toHaveBeenCalled();
    press(editor, 'y', mod);
    expect(keydown).toHaveBeenCalledOnce();
  });

  it('deletes a whole attachment with Backspace or Delete', () => {
    const { editor } = mountEditor({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'attachment', attachment: attachment() },
        { type: 'text', text: 'b' },
      ],
      from: 2,
      to: 2,
    });

    press(editor, 'Backspace');
    expect(markdown(editor)).toBe('ab');

    editor.update({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'attachment', attachment: attachment() },
        { type: 'text', text: 'b' },
      ],
      from: 1,
      to: 1,
    });
    press(editor, 'Delete');
    expect(markdown(editor)).toBe('ab');
  });

  it('leaves deleting single characters to the browser and deletes selected text', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: 'abcd' }], from: 2, to: 2 });

    expect(press(editor, 'Backspace').defaultPrevented).toBe(false);
    expect(press(editor, 'Delete').defaultPrevented).toBe(false);
    expect(markdown(editor)).toBe('abcd');

    select(editor, 1, 3);
    press(editor, 'Backspace');
    expect(markdown(editor)).toBe('cd');

    editor.update({ parts: [{ type: 'text', text: 'abcd' }], from: 0, to: 0 });
    select(editor, 1, 3);
    press(editor, 'Delete');
    expect(markdown(editor)).toBe('cd');
  });

  it('undoes an automatic format with Backspace', () => {
    const { editor } = mountEditor();
    type(editor, '# ');
    expect(blocks(editor)).toEqual(['heading']);

    press(editor, 'Backspace');

    expect(blocks(editor)).toEqual(['paragraph']);
    expect(markdown(editor)).toBe('\\# ');
  });

  it('indents list items and code with Tab and outdents with Shift-Tab', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: '- one\n- two' }], from: 11, to: 11 });

    press(editor, 'Tab');
    expect(markdown(editor)).toBe('* one\n  * two');
    press(editor, 'Tab', { shiftKey: true });
    expect(markdown(editor)).toBe('* one\n* two');

    editor.update({ parts: [{ type: 'text', text: '```\nx\n```' }], from: 0, to: 0 });
    select(editor, 1);
    press(editor, 'Tab');
    expect(markdown(editor)).toBe('```\n  x\n```');

    editor.update({ parts: [{ type: 'text', text: 'plain' }], from: 0, to: 0 });
    expect(press(editor, 'Tab').defaultPrevented).toBe(false);
  });

  it('moves out of a code block into a new paragraph with the arrow keys', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: '```\ncode\n```' }], from: 0, to: 0 });
    select(editor, 5);

    press(editor, 'ArrowDown');
    expect(blocks(editor)).toEqual(['code_block', 'paragraph']);
    expect(editor.view.state.selection.from).toBe(7);

    select(editor, 1);
    press(editor, 'ArrowUp');
    expect(blocks(editor)).toEqual(['paragraph', 'code_block', 'paragraph']);
    expect(editor.view.state.selection.from).toBe(1);
  });

  it('moves out of a code block into an adjacent paragraph with the arrow keys', () => {
    const { editor } = mountEditor({
      parts: [{ type: 'text', text: 'above\n\n```\ncode\n```\n\nbelow' }],
      from: 0,
      to: 0,
    });
    const codeStart = 8;
    const codeEnd = codeStart + 4;

    select(editor, codeStart);
    press(editor, 'ArrowLeft');
    expect(editor.view.state.selection.from).toBe(6);

    select(editor, codeEnd);
    press(editor, 'ArrowRight');
    expect(editor.view.state.selection.from).toBe(codeEnd + 2);
    expect(blocks(editor)).toEqual(['paragraph', 'code_block', 'paragraph']);
  });

  it('moves normally with the arrow keys elsewhere', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: '```\ncode\n```\n\ntext' }], from: 0, to: 0 });

    select(editor, 3);
    expect(press(editor, 'ArrowDown').defaultPrevented).toBe(false);
    select(editor, 1, 3);
    expect(press(editor, 'ArrowUp').defaultPrevented).toBe(false);
    select(editor, 9);
    expect(press(editor, 'ArrowUp').defaultPrevented).toBe(false);

    editor.update({ parts: [{ type: 'attachment', attachment: attachment() }], from: 0, to: 0 });
    editor.view.dispatch(editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, 1)));
    expect(press(editor, 'ArrowRight').defaultPrevented).toBe(false);
  });

  it.each([
    ['> ', 'blockquote'],
    ['- ', 'bullet_list'],
    ['* ', 'bullet_list'],
    ['1. ', 'ordered_list'],
    ['## ', 'heading'],
    ['```ts ', 'code_block'],
  ])('formats a block when typing %j at the start of a line', (input, block) => {
    const { editor } = mountEditor();

    type(editor, input);

    expect(blocks(editor)).toEqual([block]);
  });

  it('remembers the heading level and code language', () => {
    const { editor } = mountEditor();
    type(editor, '### ');
    expect(editor.view.state.doc.firstChild?.attrs.level).toBe(3);

    editor.update({ parts: [], from: 0, to: 0 });
    type(editor, '```python ');
    expect(editor.view.state.doc.firstChild?.attrs.params).toBe('python');
  });

  it('continues an ordered list only from the next number', () => {
    const listThenParagraph = { parts: [{ type: 'text' as const, text: '1. one\n\nx' }], from: 9, to: 9 };
    const emptyParagraph = () => {
      const size = editor.view.state.doc.content.size;
      editor.view.dispatch(editor.view.state.tr.delete(size - 2, size - 1));
    };
    const { editor } = mountEditor(listThenParagraph);
    emptyParagraph();

    type(editor, '2. ');
    expect(blocks(editor)).toEqual(['ordered_list']);
    expect(editor.view.state.doc.firstChild?.childCount).toBe(2);

    editor.update(listThenParagraph);
    emptyParagraph();
    type(editor, '5. ');
    expect(blocks(editor)).toEqual(['ordered_list', 'ordered_list']);
  });

  it.each([
    ['[docs](https://example.com)', '[docs](https://example.com)'],
    ['**bold**', '**bold**'],
    ['__bold__', '**bold**'],
    ['_em_', '*em*'],
    ['a _em_', 'a *em*'],
    ['*em*', '*em*'],
    ['a *em*', 'a *em*'],
    ['`code`', '`code`'],
  ])('formats inline markdown typed as %j', (input, output) => {
    const { editor } = mountEditor();

    type(editor, input);
    type(editor, 'x');

    expect(markdown(editor)).toBe(`${output}x`);
  });

  it('turns a typed code fence into a code block on a new line', () => {
    const { editor } = mountEditor();
    editor.view.dispatch(editor.view.state.tr.insertText('```ts'));

    editor.insertNewline();

    expect(blocks(editor)).toEqual(['code_block']);
    expect(editor.view.state.doc.firstChild?.attrs.params).toBe('ts');
    expect(editor.view.state.doc.firstChild?.textContent).toBe('');
  });

  it('adds a line inside code, splits list items and splits paragraphs on a new line', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: '```\nab\n```' }], from: 0, to: 0 });
    select(editor, 2);
    editor.insertNewline();
    expect(editor.view.state.doc.firstChild?.textContent).toBe('a\nb');

    editor.update({ parts: [{ type: 'text', text: '- ab' }], from: 3, to: 3 });
    editor.insertNewline();
    expect(markdown(editor)).toBe('* a\n* b');

    editor.update({ parts: [{ type: 'text', text: 'ab' }], from: 1, to: 1 });
    editor.insertNewline();
    expect(blocks(editor)).toEqual(['paragraph', 'paragraph']);
  });

  it('does not treat selected or non-paragraph fences as code block starts', () => {
    const { editor } = mountEditor();
    editor.view.dispatch(editor.view.state.tr.insertText('```ts'));
    select(editor, 1, 6);
    editor.insertNewline();
    expect(blocks(editor)).toEqual(['paragraph', 'paragraph']);

    editor.update({ parts: [{ type: 'text', text: '# ```' }], from: 5, to: 5 });
    editor.insertNewline();
    expect(blocks(editor)).toEqual(['heading', 'paragraph']);
  });

  it('does not add lines while read-only or composing', () => {
    const { editor } = mountEditor({ parts: [{ type: 'text', text: 'ab' }], from: 1, to: 1 });

    editor.setEditable(false);
    editor.insertNewline();
    expect(editor.view.dom.getAttribute('contenteditable')).toBe('false');
    expect(blocks(editor)).toEqual(['paragraph']);

    editor.setEditable(true);
    Object.defineProperty(editor.view, 'composing', { value: true, configurable: true });
    editor.insertNewline();
    expect(blocks(editor)).toEqual(['paragraph']);
  });

  it('pastes plain text and text into code blocks literally', () => {
    const { editor } = mountEditor();
    const paste = (text: string) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.view.dom.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    };

    paste('plain words');
    expect(markdown(editor)).toBe('plain words');

    editor.update({ parts: [{ type: 'text', text: '```\n\n```' }], from: 0, to: 0 });
    select(editor, 1);
    paste('# not a heading');
    expect(blocks(editor)).toEqual(['code_block']);
    expect(editor.view.state.doc.firstChild?.textContent).toBe('# not a heading');
  });

  it('pastes markdown as formatted text without trusting clipboard markup', () => {
    const { editor } = mountEditor();
    const data = new DataTransfer();
    data.setData('text/plain', '# Title\n\n- item');
    data.setData('text/html', '<span data-glyph-attachment="true">secret</span>');

    editor.view.dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );

    expect(markdown(editor)).toBe('# Title\n\n* item');
  });

  it('leaves pastes without clipboard data to the editor', () => {
    const { editor } = mountEditor();

    const handled = editor.view.someProp('handlePaste', handler =>
      handler(editor.view, new ClipboardEvent('paste'), editor.view.state.doc.slice(0)),
    );

    expect(handled).toBeFalsy();
  });

  it('applies host updates without echoing its own changes', () => {
    const callbacks = promptCallbacks();
    const { editor } = mountEditor(undefined, callbacks);
    type(editor, 'draft');
    const state = editor.view.state;

    editor.update({ parts: [{ type: 'text', text: 'draft' }], from: 1, to: 1 });
    expect(editor.view.state).toBe(state);

    editor.update({
      parts: [
        { type: 'text', text: 'draft' },
        { type: 'text', text: '' },
      ],
      from: 5,
      to: 5,
    });
    expect(editor.view.state).toBe(state);

    editor.update({ parts: [{ type: 'text', text: 'new @fi' }], from: 7, to: 7 });
    expect(markdown(editor)).toBe('new @fi');
    expect(callbacks.query).toHaveBeenLastCalledWith({ text: 'fi', from: 5, to: 8 });
  });

  it('starts over with fresh history when the host clears the prompt', () => {
    const { editor } = mountEditor();
    type(editor, 'sent');

    editor.update({ parts: [], from: 0, to: 0 });
    press(editor, 'z', mod);

    expect(markdown(editor)).toBe('');
  });

  it('focuses the prompt', () => {
    const { editor } = mountEditor();

    editor.focus();

    expect(document.activeElement).toBe(editor.view.dom);
  });

  it('removes the prompt and stops containing keys once destroyed', () => {
    const container = document.createElement('div');
    document.body.append(container);
    onTestFinished(() => {
      container.remove();
    });
    const editor = new GlyphPromptEditor(container, { parts: [], from: 0, to: 0 }, promptCallbacks());
    const dom = editor.view.dom;
    const stopped = vi.spyOn(KeyboardEvent.prototype, 'stopPropagation');
    onTestFinished(() => {
      stopped.mockRestore();
    });

    editor.destroy();
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    event.preventDefault();
    dom.dispatchEvent(event);

    expect(container.contains(dom)).toBe(false);
    expect(stopped).not.toHaveBeenCalled();
  });

  it('builds prompts from the shared schema', () => {
    const { editor } = mountEditor();

    expect(editor.view.state.schema).toBe(promptSchema);
  });
});
