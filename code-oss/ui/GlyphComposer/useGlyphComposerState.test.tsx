import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphContextCandidateKind, type GlyphContextCandidate } from '#src/desktop/workbench/GlyphContextActions.js';
import { GlyphComposerCommand } from '#src/desktop/workbench/GlyphComposerCommand.js';
import { GlyphComposerState as ComposerModel } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphFollowUpBehavior } from '#src/desktop/workbench/GlyphFollowUpBehavior.js';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphContextAttachment } from '#src/desktop/tests/fixtures/aGlyphContextAttachment.ts';
import { GlyphComposer } from '#code-oss/ui/GlyphComposer/GlyphComposer.presentational.tsx';
import {
  useGlyphComposerState,
  type GlyphComposerState,
  type GlyphComposerStateOptions,
} from '#code-oss/ui/GlyphComposer/useGlyphComposerState.ts';

afterEach(cleanup);

const patience = { timeout: 10000 };

function composerActions(overrides: Partial<GlyphWorkbenchViewActions> = {}): GlyphWorkbenchViewActions {
  return {
    composer: new ComposerModel(),
    context: {
      selectFiles: vi.fn(async () => []),
      searchFiles: vi.fn(async () => []),
      searchRules: vi.fn(async () => []),
      captureFile: vi.fn(async (uri: string) => fileAttachment({ uri })),
      openAttachment: vi.fn(async () => {}),
      refreshAttachment: vi.fn(async (attachment: GlyphContextAttachment) => attachment),
      checkAttachment: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(),
    ...overrides,
  } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;
}

function fileAttachment(overrides: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment {
  return aGlyphContextAttachment({
    id: 'attachment-1',
    uri: 'file:///workspace/src/a.ts',
    path: 'src/a.ts',
    contentRevision: '0123456789abcdef',
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderComposer(options: GlyphComposerStateOptions) {
  const result = {} as { current: GlyphComposerState };
  function Harness(props: GlyphComposerStateOptions) {
    result.current = useGlyphComposerState(props);
    return <GlyphComposer {...result.current} modeControl={null} />;
  }
  const view = render(<Harness {...options} />);
  return {
    result,
    rerender: (next: GlyphComposerStateOptions) => {
      view.rerender(<Harness {...next} />);
    },
    unmount: view.unmount,
  };
}

function typeDraft(composer: ComposerModel, text: string) {
  act(() => {
    composer.setDocument({ parts: [{ type: 'text', text }], from: text.length, to: text.length });
  });
}

function attach(composer: ComposerModel, attachment: GlyphContextAttachment) {
  act(() => {
    composer.insertAttachments([attachment]);
  });
}

function prompt() {
  return screen.getByRole('textbox', { name: 'Message Glyph' });
}

function sendButton() {
  return document.querySelector<HTMLButtonElement>('.glyph-send')!;
}

function picker(mode: 'context' | 'rules' = 'context') {
  return screen.queryByRole('listbox', { name: mode === 'rules' ? 'Rules to invoke' : 'Files and folders to attach' });
}

async function openPicker(actions: GlyphWorkbenchViewActions, text: string, candidates: GlyphContextCandidate[]) {
  const rules = text.startsWith('/');
  vi.mocked(rules ? actions.context.searchRules : actions.context.searchFiles).mockResolvedValue(candidates);
  typeDraft(actions.composer, text);
  if (candidates.length > 0) await screen.findAllByRole('option', {}, patience);
  else
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(rules ? 'No matching rules' : 'No matching files');
    }, patience);
}

describe(useGlyphComposerState, () => {
  it('sends the draft on Enter and clears the prompt', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Hello');

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect(actions.send).toHaveBeenCalledWith('Hello', [], {});
    expect(actions.composer.snapshot.draft).toBe('');
    expect(prompt().textContent).toBe('');
    expect(prompt().getAttribute('aria-expanded')).toBe('false');
  });

  it('sends from the send button labeled with the default shortcut', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Hi');

    expect(sendButton().getAttribute('aria-label')).toBe('Send (Enter)');
    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(actions.send).toHaveBeenCalledWith('Hi', [], {});
  });

  it('defers keys and shortcut labels to host keybindings', () => {
    const unbind = vi.fn();
    const composerKeybindings = { mount: vi.fn(() => unbind), dispatch: vi.fn(() => true), label: vi.fn(() => '⌘↩') };
    const actions = composerActions({ composerKeybindings });
    const { unmount } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Hi');

    expect(composerKeybindings.mount).toHaveBeenCalledWith(prompt());
    expect(sendButton().getAttribute('aria-label')).toBe('Send (⌘↩)');
    expect(composerKeybindings.label).toHaveBeenCalledWith(GlyphComposerCommand.SEND);
    fireEvent.keyDown(prompt(), { key: 'Enter' });
    expect(composerKeybindings.dispatch).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));
    expect(actions.send).not.toHaveBeenCalled();
    unmount();

    expect(unbind).toHaveBeenCalledOnce();
  });

  it('omits the shortcut when the host has none for sending', () => {
    const actions = composerActions({
      composerKeybindings: {
        mount: vi.fn(() => () => {}),
        dispatch: vi.fn(() => false),
        label: vi.fn(() => undefined),
      },
    });
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    expect(sendButton().getAttribute('aria-label')).toBe('Send');
  });

  it('queues follow-ups while a response is running and offers to cancel it', () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.STREAMING, actions });
    expect(sendButton().getAttribute('aria-label')).toBe('Cancel');
    expect(sendButton().querySelector('svg[fill="currentColor"]')).not.toBeNull();
    typeDraft(actions.composer, 'Also check tests');

    expect(sendButton().getAttribute('aria-label')).toBe('Queue message');
    fireEvent.keyDown(prompt(), { key: 'Enter' });
    expect(actions.composer.snapshot.queued.map(message => message.text)).toEqual(['Also check tests']);
    expect(actions.send).not.toHaveBeenCalled();
    typeDraft(actions.composer, 'Stop now');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(actions.cancel).toHaveBeenCalledOnce();
    expect(actions.composer.snapshot.queuePaused).toBe(true);
  });

  it('cancels the running response from the send button when the prompt is empty', () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.WAITING_FOR_APPROVAL, actions });

    fireEvent.click(sendButton());

    expect(actions.cancel).toHaveBeenCalledOnce();
  });

  it('sends follow-ups immediately when configured to', async () => {
    const sendImmediately = vi.fn(async () => {});
    const actions = composerActions({ followUpBehavior: GlyphFollowUpBehavior.SEND_IMMEDIATELY, sendImmediately });
    renderComposer({ status: GlyphWorkbenchStatus.WAITING_FOR_QUESTION, actions });
    typeDraft(actions.composer, 'Right away');

    expect(sendButton().getAttribute('aria-label')).toBe('Send immediately');
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect(sendImmediately).toHaveBeenCalledWith('Right away', [], {});
  });

  it('keeps the draft when immediate sending is unavailable', async () => {
    const actions = composerActions({ followUpBehavior: GlyphFollowUpBehavior.SEND_IMMEDIATELY });
    renderComposer({ status: GlyphWorkbenchStatus.STREAMING, actions });
    typeDraft(actions.composer, 'Right away');

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect(actions.send).not.toHaveBeenCalled();
    expect(actions.composer.snapshot.draft).toBe('Right away');
  });

  it('saves edits to a queued message', () => {
    const actions = composerActions({ managesQueue: true });
    typeDraft(actions.composer, 'Original');
    actions.composer.enqueueDraft();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    const [queued] = actions.composer.snapshot.queued;

    act(() => {
      result.current.editQueued(queued!.id);
    });
    expect(screen.getByText('Editing queued message')).toBeTruthy();
    expect(sendButton().getAttribute('aria-label')).toBe('Save queued message');
    typeDraft(actions.composer, '');
    expect(sendButton().disabled).toBe(true);
    typeDraft(actions.composer, 'Edited');
    fireEvent.keyDown(prompt(), { key: 'Enter' });

    expect(actions.composer.snapshot.queued.map(message => message.text)).toEqual(['Edited']);
    expect(screen.queryByText('Editing queued message')).toBeNull();
  });

  it('cancels editing a queued message', () => {
    const actions = composerActions({ managesQueue: true });
    typeDraft(actions.composer, 'Original');
    actions.composer.enqueueDraft();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    act(() => {
      result.current.editQueued(actions.composer.snapshot.queued[0]!.id);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel queue edit' }));

    expect(actions.composer.snapshot.editingQueuedMessage).toBeUndefined();
    expect(actions.composer.snapshot.draft).toBe('');
  });

  it('steers a running response on command', async () => {
    const steer = vi.fn(async () => {});
    const actions = composerActions({ steer });
    const { rerender } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Go left');

    await act(async () => {
      actions.composer.executeCommand(GlyphComposerCommand.STEER);
    });
    expect(steer).not.toHaveBeenCalled();
    rerender({ status: GlyphWorkbenchStatus.STREAMING, actions, disabled: true });
    await act(async () => {
      actions.composer.executeCommand(GlyphComposerCommand.STEER);
    });
    expect(steer).not.toHaveBeenCalled();
    rerender({ status: GlyphWorkbenchStatus.STREAMING, actions: composerActions({ composer: actions.composer }) });
    await act(async () => {
      actions.composer.executeCommand(GlyphComposerCommand.STEER);
    });
    expect(steer).not.toHaveBeenCalled();
    rerender({ status: GlyphWorkbenchStatus.STREAMING, actions });
    await act(async () => {
      actions.composer.executeCommand(GlyphComposerCommand.STEER);
    });

    expect(steer).toHaveBeenCalledWith('Go left', [], {});
  });

  it('steers from the editor shortcut when the host has no keybindings', async () => {
    const steer = vi.fn(async () => {});
    const actions = composerActions({ steer });
    renderComposer({ status: GlyphWorkbenchStatus.STREAMING, actions });
    typeDraft(actions.composer, 'Go right');
    const modifier = /Mac|iP(hone|[oa]d)/u.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter', ...modifier });
    });

    expect(steer).toHaveBeenCalledWith('Go right', [], {});
  });

  it('replaces the draft text', () => {
    const actions = composerActions();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    act(() => {
      result.current.updateDraft('Replaced');
    });

    expect(actions.composer.snapshot.draft).toBe('Replaced');
    expect(prompt().textContent).toBe('Replaced');
  });

  it('sends and inserts new lines on command', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Line');

    act(() => {
      actions.composer.executeCommand(GlyphComposerCommand.INSERT_NEWLINE);
    });
    expect(actions.composer.snapshot.draft).toBe('Line\n\n');
    act(() => {
      actions.composer.executeCommand('glyph.unknown' as GlyphComposerCommand);
    });
    await act(async () => {
      actions.composer.executeCommand(GlyphComposerCommand.SEND);
    });

    expect(actions.send).toHaveBeenCalledWith('Line\n\n', [], {});
  });

  it('sends nothing while disabled', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions, disabled: true });
    typeDraft(actions.composer, 'Hello');

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect(actions.send).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Attach file' }).disabled).toBe(true);
  });

  it('runs one operation at a time and ignores sends meanwhile', async () => {
    const selection = deferred<readonly GlyphContextAttachment[]>();
    const actions = composerActions();
    actions.context.selectFiles = vi.fn(() => selection.promise);
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Hello');
    const attachButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Attach file' });

    act(() => {
      attachButton.click();
      attachButton.click();
      sendButton().click();
      actions.composer.executeCommand(GlyphComposerCommand.SEND);
    });
    expect(actions.context.selectFiles).toHaveBeenCalledOnce();
    expect(actions.send).not.toHaveBeenCalled();
    expect(prompt().getAttribute('contenteditable')).toBe('false');
    expect(attachButton.disabled).toBe(true);
    await act(async () => {
      selection.resolve([]);
    });

    await waitFor(() => {
      expect(attachButton.disabled).toBe(false);
    }, patience);
    expect(prompt().getAttribute('contenteditable')).toBe('true');
  });

  it('searches files after @ and inserts the chosen file', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    await openPicker(actions, 'Read @src', [
      { uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' },
      { uri: 'file:///workspace/src/b.ts', path: 'src/b.ts' },
    ]);
    expect(actions.context.searchFiles).toHaveBeenCalledWith('src');
    const listbox = picker()!;
    expect(prompt().getAttribute('aria-expanded')).toBe('true');
    expect(prompt().getAttribute('aria-controls')).toBe(listbox.id);
    expect(prompt().getAttribute('aria-activedescendant')).toBe(`${listbox.id}-0`);
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' });
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' });
    expect(prompt().getAttribute('aria-activedescendant')).toBe(`${listbox.id}-1`);
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' });
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' });
    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    await waitFor(() => {
      expect(picker()).toBeNull();
    }, patience);
    expect(actions.context.captureFile).toHaveBeenCalledWith('file:///workspace/src/b.ts');
    expect(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' })).toBeTruthy();
    expect(actions.composer.snapshot.document.parts).toEqual([
      { type: 'text', text: 'Read ' },
      { type: 'attachment', attachment: fileAttachment({ uri: 'file:///workspace/src/b.ts' }) },
    ]);
    expect(prompt().hasAttribute('aria-controls')).toBe(false);
    expect(document.activeElement).toBe(prompt());
  });

  it('chooses files by clicking them', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'src/a.ts' }));
    });

    await waitFor(() => {
      expect(picker()).toBeNull();
    }, patience);
    expect(actions.context.captureFile).toHaveBeenCalledWith('file:///workspace/src/a.ts');
  });

  it('inserts a manual rule as a composer-only context badge', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '/typ', [
      {
        uri: 'glyph-rule:typescript',
        path: 'TypeScript',
        kind: GlyphContextCandidateKind.RULE,
        ruleId: 'rule-id',
      },
    ]);

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'TypeScript' }));
    });

    expect(actions.context.captureFile).not.toHaveBeenCalled();
    expect(actions.context.searchRules).toHaveBeenCalledWith('typ');
    expect(actions.context.searchFiles).not.toHaveBeenCalled();
    expect(actions.composer.snapshot.document.parts).toEqual([
      {
        type: 'attachment',
        attachment: {
          kind: GlyphContextAttachmentKind.RULE,
          uri: 'glyph-rule:typescript',
          path: 'TypeScript',
          text: '',
          contentRevision: 'rule-id',
          ruleId: 'rule-id',
        },
      },
    ]);
  });

  it('rejects manual rule candidates without a selection position or stable id', async () => {
    const actions = composerActions();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await act(() =>
      result.current.choose({
        uri: 'glyph-rule:missing',
        path: 'Missing',
        kind: GlyphContextCandidateKind.RULE,
        ruleId: 'rule-id',
      }),
    );
    expect(screen.getByRole('alert').textContent).toBe('This rule cannot be selected.');

    await openPicker(actions, '/missing', [
      { uri: 'glyph-rule:missing', path: 'Missing', kind: GlyphContextCandidateKind.RULE },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Missing' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('This rule cannot be selected.');
  });

  it('closes the file search on Escape and keeps other keys working', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);

    fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(prompt(), { key: 'x' });
    expect(picker()).not.toBeNull();
    fireEvent.keyDown(prompt(), { key: 'Escape' });

    expect(picker()).toBeNull();
    expect(prompt().getAttribute('aria-expanded')).toBe('false');
  });

  it('lets host keybindings handle keys while searching files', async () => {
    const composerKeybindings = {
      mount: vi.fn(() => () => {}),
      dispatch: vi.fn(() => true),
      label: vi.fn(() => 'Enter'),
    };
    const actions = composerActions({ composerKeybindings });
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);

    fireEvent.keyDown(prompt(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(prompt(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(prompt(), { key: 'Tab' });

    expect(composerKeybindings.dispatch).toHaveBeenCalledTimes(4);
    expect(picker()).not.toBeNull();
    expect(actions.context.captureFile).not.toHaveBeenCalled();
  });

  it('does nothing when confirming an empty file search', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@zzz', []);

    fireEvent.keyDown(prompt(), { key: 'ArrowDown' });
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' });
    fireEvent.keyDown(prompt(), { key: 'Enter' });

    expect(actions.context.captureFile).not.toHaveBeenCalled();
    expect(prompt().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('reports failed file searches', async () => {
    const actions = composerActions();
    vi.mocked(actions.context.searchFiles)
      .mockRejectedValueOnce(new Error('Index unavailable'))
      .mockRejectedValueOnce('Timed out');
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    typeDraft(actions.composer, '@a');
    expect((await screen.findByRole('alert', {}, patience)).textContent).toBe('Index unavailable');
    typeDraft(actions.composer, '@b');

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Timed out');
    }, patience);
  });

  it('discards searches for text that has since changed', async () => {
    const first = deferred<readonly GlyphContextCandidate[]>();
    const second = deferred<readonly GlyphContextCandidate[]>();
    const actions = composerActions();
    vi.mocked(actions.context.searchFiles)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue([{ uri: 'file:///workspace/final.ts', path: 'final.ts' }]);
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    typeDraft(actions.composer, '@skipped');
    typeDraft(actions.composer, '@one');
    await waitFor(() => {
      expect(actions.context.searchFiles).toHaveBeenCalledWith('one');
    }, patience);
    typeDraft(actions.composer, '@two');
    await waitFor(() => {
      expect(actions.context.searchFiles).toHaveBeenCalledWith('two');
    }, patience);
    typeDraft(actions.composer, '@final');
    await act(async () => {
      first.resolve([{ uri: 'file:///workspace/stale.ts', path: 'stale.ts' }]);
      second.reject(new Error('stale failure'));
      await Promise.allSettled([first.promise, second.promise]);
    });

    expect(await screen.findByRole('option', { name: 'final.ts' }, patience)).toBeTruthy();
    expect(actions.context.searchFiles).not.toHaveBeenCalledWith('skipped');
    expect(screen.queryByRole('option', { name: 'stale.ts' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('attaches folders when the host supports them', async () => {
    const actions = composerActions();
    const captureFolder = vi.fn(async () =>
      fileAttachment({ kind: GlyphContextAttachmentKind.FOLDER, path: 'src', uri: 'file:///workspace/src' }),
    );
    actions.context.captureFolder = captureFolder;
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@sr', [
      { uri: 'file:///workspace/src', path: 'src/', kind: GlyphContextCandidateKind.FOLDER },
    ]);

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    await waitFor(() => {
      expect(captureFolder).toHaveBeenCalledWith('file:///workspace/src');
    }, patience);
  });

  it('explains when folders cannot be attached', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@sr', [
      { uri: 'file:///workspace/src', path: 'src/', kind: GlyphContextCandidateKind.FOLDER },
    ]);

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect((await screen.findByRole('alert', {}, patience)).textContent).toBe('Folder context is unavailable.');
  });

  it('refuses a capture when the prompt changed meanwhile', async () => {
    const capture = deferred<GlyphContextAttachment>();
    const actions = composerActions();
    actions.context.captureFile = vi.fn(() => capture.promise);
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);

    act(() => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });
    act(() => {
      actions.composer.setDraft('Changed');
    });
    await act(async () => {
      capture.resolve(fileAttachment());
    });

    expect((await screen.findByRole('alert', {}, patience)).textContent).toBe(
      'The prompt changed during capture. Choose the file again.',
    );
  });

  it('asks for an @ position before inserting a file', async () => {
    const actions = composerActions();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    await act(() => result.current.choose({ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }));

    expect(screen.getByRole('alert').textContent).toBe('Type @ to choose where to insert a file.');
  });

  it('abandons captures that finish after the composer closes', async () => {
    const capture = deferred<GlyphContextAttachment>();
    const actions = composerActions();
    actions.context.captureFile = vi.fn(() => capture.promise);
    const { unmount } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);
    act(() => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    unmount();
    await act(async () => {
      capture.resolve(fileAttachment());
    });

    expect(actions.composer.snapshot.document.parts).toEqual([{ type: 'text', text: '@a' }]);
  });

  it('abandons failures that finish after the composer switches models', async () => {
    const capture = deferred<GlyphContextAttachment>();
    const actions = composerActions();
    actions.context.captureFile = vi.fn(() => capture.promise);
    const { rerender } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    await openPicker(actions, '@a', [{ uri: 'file:///workspace/src/a.ts', path: 'src/a.ts' }]);
    act(() => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    rerender({ status: GlyphWorkbenchStatus.READY, actions: { ...actions, composer: new ComposerModel() } });
    await act(async () => {
      capture.reject(new Error('Too late'));
    });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('attaches files chosen from the file dialog', async () => {
    const actions = composerActions();
    actions.context.selectFiles = vi
      .fn()
      .mockResolvedValueOnce([fileAttachment()])
      .mockResolvedValueOnce([]) as GlyphWorkbenchViewActions['context']['selectFiles'];
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'See ');

    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Attach file' }))).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    });
    expect(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    });

    expect(actions.composer.snapshot.document.parts.filter(part => part.type === 'attachment')).toHaveLength(1);
    expect(actions.context.selectFiles).toHaveBeenCalledTimes(2);
  });

  it('refuses dialog files when the prompt changed meanwhile', async () => {
    const selection = deferred<readonly GlyphContextAttachment[]>();
    const actions = composerActions();
    actions.context.selectFiles = vi.fn(() => selection.promise);
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    });
    act(() => {
      actions.composer.setDraft('Changed');
    });
    await act(async () => {
      selection.resolve([fileAttachment()]);
    });

    expect((await screen.findByRole('alert', {}, patience)).textContent).toBe(
      'The prompt changed during capture. Choose the files again.',
    );
  });

  it('abandons dialog files chosen after the composer closes', async () => {
    const selection = deferred<readonly GlyphContextAttachment[]>();
    const actions = composerActions();
    actions.context.selectFiles = vi.fn(() => selection.promise);
    const { unmount } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Attach file' }));
    });

    unmount();
    await act(async () => {
      selection.resolve([fileAttachment()]);
    });

    expect(actions.composer.snapshot.document.parts).toEqual([]);
  });

  it('previews captured attachments and their source status', async () => {
    const actions = composerActions();
    actions.context.checkAttachment = vi.fn(async () => 'Source changed since capture');
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(
      actions.composer,
      fileAttachment({
        kind: GlyphContextAttachmentKind.SELECTION,
        range: { start: { line: 3, column: 0 }, end: { line: 5, column: 0 } },
        side: 'modified',
      }),
    );

    const badge = within(prompt()).getByRole('button', { name: 'Preview src/a.ts (3-5)' });
    fireEvent.mouseEnter(badge.parentElement!);
    await act(async () => {
      fireEvent.click(badge);
    });

    const preview = screen.getByRole('region', { name: 'Attachment preview' });
    expect(preview.querySelector('strong')!.textContent).toBe('src/a.ts (3-5) · modified');
    expect(within(preview).getByText('Captured revision 0123456789ab')).toBeTruthy();
    expect(within(preview).getByText('const a = 1;')).toBeTruthy();
    expect(actions.context.openAttachment).toHaveBeenCalledWith(expect.objectContaining({ id: 'attachment-1' }));
    expect((await within(preview).findByRole('status', {}, patience)).textContent).toBe('Source changed since capture');
    expect(within(preview).getByRole('button', { name: 'Refresh capture' })).toBeTruthy();
  });

  it('opens attachments that cannot be previewed', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, fileAttachment({ kind: GlyphContextAttachmentKind.DIAGNOSTIC }));

    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Open src/a.ts' }));
    });

    expect(actions.context.openAttachment).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region', { name: 'Attachment preview' })).toBeNull();
  });

  it('refreshes, opens, removes and closes the preview', async () => {
    const refreshed = fileAttachment({ text: 'const a = 2;', contentRevision: 'fedcba9876543210' });
    const actions = composerActions();
    actions.context.refreshAttachment = vi.fn(async () => refreshed);
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, fileAttachment());
    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
    });
    const preview = () => screen.queryByRole('region', { name: 'Attachment preview' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh capture' }));
    });
    expect(within(preview()!).getByText('const a = 2;')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open source' }));
    });
    expect(actions.context.openAttachment).toHaveBeenLastCalledWith(refreshed);
    fireEvent.click(screen.getByRole('button', { name: 'Close attachment preview' }));
    expect(preview()).toBeNull();
    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(preview()).toBeNull();
    expect(actions.composer.snapshot.document.parts).toEqual([]);
    expect(document.activeElement).toBe(prompt());
  });

  it('keeps previews of unidentified captures read only', async () => {
    const actions = composerActions();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, {
      kind: GlyphContextAttachmentKind.FOLDER,
      uri: 'file:///workspace/src/a.ts',
      path: 'src/a.ts',
      text: 'const a = 1;',
      contentRevision: '0123456789abcdef',
    });
    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh capture' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(actions.context.refreshAttachment).not.toHaveBeenCalled();
    expect(actions.composer.snapshot.document.parts).toHaveLength(1);
  });

  it('reports failures to check a preview source', async () => {
    const actions = composerActions();
    actions.context.checkAttachment = vi.fn().mockRejectedValue('Permission denied');
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, fileAttachment());

    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
    });

    expect((await screen.findByRole('status', {}, patience)).textContent).toBe('Permission denied');
  });

  it('ignores source checks that finish after the preview closed', async () => {
    const success = deferred<string | undefined>();
    const failure = deferred<string | undefined>();
    const actions = composerActions();
    actions.context.checkAttachment = vi
      .fn()
      .mockReturnValueOnce(success.promise)
      .mockReturnValueOnce(failure.promise) as GlyphWorkbenchViewActions['context']['checkAttachment'];
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, fileAttachment());

    for (const check of [success, failure]) {
      await act(async () => {
        fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close attachment preview' }));
      await act(async () => {
        if (check === success) check.resolve('late');
        else check.reject('late failure');
        await check.promise.catch(() => {});
      });
    }

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not refresh a preview after the composer closes', async () => {
    const refresh = deferred<GlyphContextAttachment>();
    const actions = composerActions();
    actions.context.refreshAttachment = vi.fn(() => refresh.promise);
    const replace = vi.spyOn(actions.composer, 'replaceAttachment');
    const { unmount } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    attach(actions.composer, fileAttachment());
    await act(async () => {
      fireEvent.click(within(prompt()).getByRole('button', { name: 'Preview src/a.ts' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh capture' }));

    unmount();
    await act(async () => {
      refresh.resolve(fileAttachment({ text: 'late' }));
    });

    expect(replace).toHaveBeenCalledWith('attachment-1', fileAttachment({ text: 'late' }));
  });

  it('opens nothing without a preview', async () => {
    const actions = composerActions();
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    await act(() => result.current.openPreview());

    expect(actions.context.openAttachment).not.toHaveBeenCalled();
  });

  it('sends queued messages automatically once idle', async () => {
    const actions = composerActions();
    typeDraft(actions.composer, 'Queued');
    actions.composer.enqueueDraft();

    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    await waitFor(() => {
      expect(actions.send).toHaveBeenCalledWith('Queued', [], expect.any(Object));
    }, patience);
  });

  it('leaves queued messages to hosts that manage the queue or while paused', () => {
    const managed = composerActions({ managesQueue: true });
    typeDraft(managed.composer, 'Queued');
    managed.composer.enqueueDraft();
    const paused = composerActions();
    typeDraft(paused.composer, 'Queued');
    paused.composer.enqueueDraft();
    paused.composer.pauseQueue();

    renderComposer({ status: GlyphWorkbenchStatus.READY, actions: managed });
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions: paused });

    expect(managed.send).not.toHaveBeenCalled();
    expect(paused.send).not.toHaveBeenCalled();
  });

  it('manages queued messages', async () => {
    const sendImmediately = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const moveQueuedToNewChat = vi.fn(async () => {});
    const openMessageSettings = vi.fn();
    const actions = composerActions({ sendImmediately, steer, moveQueuedToNewChat, openMessageSettings });
    for (const text of ['First', 'Second', 'Third', 'Fourth']) {
      typeDraft(actions.composer, text);
      actions.composer.enqueueDraft();
    }
    const ids = actions.composer.snapshot.queued.map(message => message.id);
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.STREAMING, actions });

    act(() => {
      result.current.moveQueued(ids[3]!, 0);
    });
    expect(actions.composer.snapshot.queued.map(message => message.text)).toEqual([
      'Fourth',
      'First',
      'Second',
      'Third',
    ]);
    act(() => {
      result.current.removeQueued(ids[3]!);
    });
    await act(async () => {
      result.current.sendQueued(ids[0]!);
    });
    await act(async () => {
      result.current.steerQueued(ids[1]!);
    });
    act(() => {
      result.current.moveQueuedToNewChat(ids[2]!);
    });
    act(() => result.current.openMessageSettings());
    act(() => {
      actions.composer.pauseQueue();
      result.current.resumeQueue();
    });

    expect(sendImmediately).toHaveBeenCalledWith('First', [], expect.any(Object));
    expect(steer).toHaveBeenCalledWith('Second', [], expect.any(Object));
    expect(moveQueuedToNewChat).toHaveBeenCalledWith(ids[2]);
    expect(openMessageSettings).toHaveBeenCalledOnce();
    expect(actions.composer.snapshot.queuePaused).toBe(false);
  });

  it('skips queue actions the host or state does not allow', async () => {
    const actions = composerActions({ managesQueue: true });
    typeDraft(actions.composer, 'Only');
    actions.composer.enqueueDraft();
    const [queued] = actions.composer.snapshot.queued;
    const sendQueued = vi.spyOn(actions.composer, 'sendQueued');
    const { result, rerender } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    act(() => {
      result.current.sendQueued(queued!.id);
      result.current.steerQueued(queued!.id);
      result.current.moveQueuedToNewChat(queued!.id);
      result.current.openMessageSettings();
    });
    rerender({
      status: GlyphWorkbenchStatus.STREAMING,
      disabled: true,
      actions: { ...actions, sendImmediately: vi.fn(), steer: vi.fn() },
    });
    act(() => {
      result.current.sendQueued(queued!.id);
      result.current.steerQueued(queued!.id);
    });
    rerender({ status: GlyphWorkbenchStatus.STREAMING, actions });
    act(() => {
      result.current.steerQueued(queued!.id);
    });

    expect(sendQueued).not.toHaveBeenCalled();
  });

  it('switches modes through the host or the prompt', async () => {
    const selectMode = vi.fn(async () => {});
    const hosted = composerActions({ selectMode });
    const local = composerActions();
    const first = renderComposer({ status: GlyphWorkbenchStatus.READY, actions: hosted });
    const second = renderComposer({ status: GlyphWorkbenchStatus.READY, actions: local });

    expect(first.result.current.mode).toBe(AgentMode.default.id);
    await act(() => first.result.current.setMode(AgentModeID.PLAN));
    await act(() => second.result.current.setMode(AgentModeID.PLAN));

    expect(selectMode).toHaveBeenCalledWith(AgentModeID.PLAN);
    expect(local.composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
    expect(second.result.current.mode).toBe(AgentModeID.PLAN);
  });

  it('reports failed operations', async () => {
    const actions = composerActions({
      selectMode: vi.fn().mockRejectedValueOnce(new Error('Mode locked')).mockRejectedValueOnce('Offline'),
    });
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    await act(() => result.current.setMode(AgentModeID.PLAN));
    expect(screen.getByRole('alert').textContent).toBe('Mode locked');
    await act(() => result.current.setMode(AgentModeID.PLAN));

    expect(screen.getByRole('alert').textContent).toBe('Offline');
  });

  it('shows prompt annotations and lets them be edited or removed', () => {
    const annotation: GlyphAnnotation = {
      id: 'note-1',
      order: 1,
      kind: 'chat',
      sourceId: 'msg-1',
      revision: '1',
      label: 'Glyph',
      quote: 'world',
      from: 0,
      to: 5,
      comment: 'Explain',
    };
    const actions = composerActions();
    actions.composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations: [annotation] } });
    const { result } = renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    expect(result.current.annotations).toEqual([annotation]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1', hidden: true }));
    expect(actions.composer.snapshot.editingAnnotation).toBe('note-1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation 1', hidden: true }));

    expect(actions.composer.snapshot.document.options?.annotations).toEqual([]);
  });

  it('restores unsent drafts for editing', () => {
    const actions = composerActions();
    actions.composer.setDraft('First draft');
    actions.composer.restoreDraft({ parts: [{ type: 'text', text: 'Second draft' }], from: 0, to: 0 });
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });

    const unsent = screen.getByRole('region', { name: 'Unsent messages' });
    expect(within(unsent).getByText('First draft')).toBeTruthy();
    fireEvent.click(within(unsent).getByRole('button', { name: 'Edit unsent message' }));

    expect(actions.composer.snapshot.draft).toBe('First draft');
    expect(within(screen.getByRole('region', { name: 'Unsent messages' })).getByText('Second draft')).toBeTruthy();
  });

  it('shows send failures from the prompt', async () => {
    const actions = composerActions({ send: vi.fn().mockRejectedValue(new Error('Network down')) });
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    typeDraft(actions.composer, 'Hello');

    await act(async () => {
      fireEvent.keyDown(prompt(), { key: 'Enter' });
    });

    expect((await screen.findByRole('alert', {}, patience)).textContent).toBe('Network down');
    expect(actions.composer.snapshot.draft).toBe('Hello');
  });

  it('focuses the prompt when asked', () => {
    const actions = composerActions();
    actions.composer.focus();
    renderComposer({ status: GlyphWorkbenchStatus.READY, actions });
    expect(document.activeElement).toBe(prompt());
    act(() => {
      prompt().blur();
    });

    act(() => {
      actions.composer.focus();
    });

    expect(document.activeElement).toBe(prompt());
  });
});
