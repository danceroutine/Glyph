import { AgentModeID } from '#src/chat/AgentMode.js';
import { describe, expect, it, vi } from 'vitest';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphComposerCommand } from '#src/desktop/workbench/GlyphComposerCommand.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

const attachment = {
  id: 'selection',
  kind: GlyphContextAttachmentKind.SELECTION,
  uri: 'file:///project/a.ts',
  path: 'a.ts',
  text: '  café 🌱\r\n\tline',
  contentRevision: 'captured-hash',
  sourceRevision: 'model:1',
  token: { workspaceGeneration: 'workspace', resource: 'file:///project/a.ts', incarnation: 'model', version: 1 },
  range: { start: { line: 2, column: 1 }, end: { line: 3, column: 6 } },
};

describe(GlyphComposerState, () => {
  it('rebinds draft, queued, and recoverable captures without changing text or caret positions', () => {
    const composer = new GlyphComposerState();
    composer.insertAttachments([attachment]);
    composer.enqueueDraft();
    composer.insertAttachments([attachment]);
    composer.restoreDraft({ parts: [{ type: 'attachment', attachment }], from: 1, to: 1 });
    composer.pauseQueue();
    composer.mapAttachments(value => ({ ...value, path: 'project/a.ts', unavailable: 'Folder removed' }));
    const check = (document: typeof composer.snapshot.document) => {
      expect(document.from).toBe(1);
      expect(document.to).toBe(1);
      expect(document.parts[0]).toEqual({
        type: 'attachment',
        attachment: { ...attachment, path: 'project/a.ts', unavailable: 'Folder removed' },
      });
    };
    check(composer.snapshot.document);
    check(composer.snapshot.queued[0]!.document);
    expect(composer.snapshot.queuePaused).toBe(true);
    composer.editUnsent(0);
    check(composer.snapshot.document);
  });
  it('saves attachment positions independently of matching literal mentions and leading whitespace', async () => {
    const model = new GlyphComposerState();
    model.setDraft('  🌱 @a.ts (2-3) then ');
    model.insertAttachments([attachment]);
    await model.submit(async (text, _attachments, options) => {
      const span = options?.attachmentSpans?.[0];
      expect(span?.from).toBe('🌱 @a.ts (2-3) then '.length);
      expect(text.trim().slice(span!.from, span!.to)).toBe('@a.ts (2-3)');
    });
  });
  it('sends manual rule badges as stable rule ids instead of captured attachments', async () => {
    const composer = new GlyphComposerState();
    composer.setDocument({
      parts: [
        { type: 'text', text: 'Use ' },
        {
          type: 'attachment',
          attachment: {
            kind: GlyphContextAttachmentKind.RULE,
            uri: 'glyph-rule:rule-id',
            path: 'Review discipline',
            text: '',
            contentRevision: 'revision',
            ruleId: 'rule-id',
          },
        },
      ],
      from: 5,
      to: 5,
    });

    await composer.submit(async (text, attachments, options) => {
      expect(text).toBe('Use /Review discipline');
      expect(attachments).toEqual([]);
      expect(options).toMatchObject({ manualRuleIds: ['rule-id'] });
      expect(options?.attachmentSpans).toBeUndefined();
    });
  });
  it('restores annotations and mode after a rejected send and keeps edits and deletion scoped to the draft', async () => {
    const composer = new GlyphComposerState();
    composer.setMode(AgentModeID.PLAN);
    composer.setDraft('Revise this');
    const annotation = {
      id: 'a',
      order: 1,
      kind: 'plan' as const,
      sourceId: 'plan',
      revision: '1',
      label: 'Plan',
      quote: 'source',
      from: 0,
      to: 6,
      comment: 'Change this',
    };
    composer.saveAnnotation(annotation);
    await composer.submit(async (_text, _attachments, options) => {
      expect(options).toEqual({ mode: AgentModeID.PLAN, annotations: [annotation] });
      throw new Error('Offline');
    });
    expect(composer.snapshot.document.options?.annotations).toEqual([annotation]);
    composer.saveAnnotation({ ...annotation, comment: 'Updated' });
    expect(composer.snapshot.document.options?.annotations?.[0]?.comment).toBe('Updated');
    composer.removeAnnotation('a');
    expect(composer.snapshot.document.options?.annotations).toEqual([]);
    composer.saveAnnotation({ ...annotation, id: 'b' });
    expect(composer.snapshot.document.options?.annotations?.[0]?.order).toBe(2);
  });

  it('continues annotation numbering after restoring a draft into a new composer', () => {
    const composer = new GlyphComposerState();
    const annotation = {
      id: 'restored',
      order: 5,
      kind: 'plan' as const,
      sourceId: 'plan',
      revision: '1',
      label: 'Plan',
      quote: 'source',
      from: 0,
      to: 6,
      comment: 'Existing comment',
    };
    composer.restoreDraft({
      parts: [{ type: 'text', text: 'Review these comments' }],
      from: 0,
      to: 0,
      options: { annotations: [{ ...annotation, id: 'earlier', order: 2 }, annotation] },
    });
    composer.saveAnnotation({ ...annotation, id: 'new', order: 0 });
    expect(composer.snapshot.document.options?.annotations?.map(value => value.order)).toEqual([2, 5, 6]);
    composer.saveAnnotation({ ...annotation, comment: 'Edited comment' });
    expect(composer.snapshot.document.options?.annotations?.map(value => value.order)).toEqual([2, 5, 6]);
    composer.removeAnnotation('new');
    composer.saveAnnotation({ ...annotation, id: 'later', order: 0 });
    expect(composer.snapshot.document.options?.annotations?.map(value => value.order)).toEqual([2, 5, 7]);
  });

  it('inserts captures at the saved selection and removes only that atom, mapping the caret', () => {
    const model = new GlyphComposerState();
    model.setDocument({ parts: [{ type: 'text', text: 'before replace after' }], from: 7, to: 14 });
    model.insertAttachments([attachment]);
    expect(model.snapshot.draft).toBe('before @a.ts (2-3) after');
    expect(model.snapshot.document.from).toBe(8);
    model.replaceAttachment('selection');
    expect(model.snapshot.draft).toBe('before  after');
    expect(model.snapshot.document.from).toBe(7);
  });
  it('keeps exact captures and order when a failed send is restored alongside a newer draft', async () => {
    const model = new GlyphComposerState();
    model.setDraft('inspect ');
    model.insertAttachments([attachment]);
    const original = model.snapshot.document;
    let reject!: (reason: Error) => void;
    const pending = model.submit((text, attachments) => {
      expect(text).toBe('inspect @a.ts (2-3)');
      expect(attachments).toEqual([attachment]);
      return new Promise((_resolve, fail) => {
        reject = fail;
      });
    });
    model.setDraft('next message');
    reject(new Error('Offline'));
    await pending;
    expect(model.snapshot.draft).toBe('next message');
    model.editUnsent(0);
    expect(model.snapshot.document).toEqual(original);
    expect(model.snapshot.unsent).toEqual(['next message']);
    await model.submit(async (_text, attachments) => {
      expect(attachments).toEqual([attachment]);
    });
  });

  describe(GlyphComposerState.prototype.registerCommands, () => {
    it('routes executed commands to the registered handler until it is unregistered', () => {
      const composer = new GlyphComposerState();
      const handler = vi.fn();
      const unregister = composer.registerCommands(handler);
      composer.executeCommand(GlyphComposerCommand.SEND);
      unregister();
      composer.executeCommand(GlyphComposerCommand.STEER);
      expect(handler).toHaveBeenCalledExactlyOnceWith(GlyphComposerCommand.SEND);
    });

    it('keeps a newer handler when an older registration is released', () => {
      const composer = new GlyphComposerState();
      const older = vi.fn();
      const newer = vi.fn();
      const unregisterOlder = composer.registerCommands(older);
      composer.registerCommands(newer);
      unregisterOlder();
      composer.executeCommand(GlyphComposerCommand.INSERT_NEWLINE);
      expect(older).not.toHaveBeenCalled();
      expect(newer).toHaveBeenCalledExactlyOnceWith(GlyphComposerCommand.INSERT_NEWLINE);
    });
  });

  describe(GlyphComposerState.prototype.hydrateMode, () => {
    it('adopts a hydrated mode only while the user has not chosen one', () => {
      const composer = new GlyphComposerState();
      const listener = vi.fn();
      composer.subscribe(listener);
      composer.hydrateMode(AgentModeID.PLAN);
      expect(composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
      composer.hydrateMode(AgentModeID.PLAN);
      expect(listener).toHaveBeenCalledTimes(1);
      composer.setMode(AgentModeID.AGENT);
      composer.hydrateMode(AgentModeID.PLAN);
      expect(composer.snapshot.document.options?.mode).toBe(AgentModeID.AGENT);
    });
  });

  describe(GlyphComposerState.prototype.revealAnnotation, () => {
    it('resolves positions through the registered source and nothing for unknown sources', async () => {
      const composer = new GlyphComposerState();
      const annotation = {
        id: 'a',
        order: 1,
        kind: 'chat' as const,
        sourceId: 'transcript',
        revision: '1',
        label: 'Chat',
        quote: 'quote',
        from: 0,
        to: 5,
        comment: 'Explain',
      };
      const reveal = vi.fn(async () => ({ x: 3, y: 4 }));
      composer.registerAnnotationSource('transcript', reveal);
      await expect(composer.revealAnnotation(annotation)).resolves.toEqual({ x: 3, y: 4 });
      expect(reveal).toHaveBeenCalledExactlyOnceWith(annotation);
      await expect(composer.revealAnnotation({ ...annotation, sourceId: 'missing' })).resolves.toBeUndefined();
    });
  });

  describe(GlyphComposerState.prototype.subscribe, () => {
    it('notifies listeners of changes until they unsubscribe', () => {
      const composer = new GlyphComposerState();
      const listener = vi.fn();
      const unsubscribe = composer.subscribe(listener);
      composer.focus();
      unsubscribe();
      composer.focus();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(composer.snapshot.focus).toBe(2);
    });
  });

  describe(GlyphComposerState.prototype.requestAnnotation, () => {
    it('holds a requested annotation draft until editing moves elsewhere', () => {
      const composer = new GlyphComposerState();
      const annotation = {
        id: 'a',
        order: 1,
        kind: 'proposal' as const,
        sourceId: 'proposal',
        revision: '1',
        label: 'Proposal',
        quote: 'quote',
        from: 0,
        to: 5,
        comment: '',
      };
      composer.requestAnnotation(annotation);
      expect(composer.snapshot.annotationDraft).toEqual(annotation);
      composer.editAnnotation('a');
      expect(composer.snapshot.annotationDraft).toBeUndefined();
      expect(composer.snapshot.editingAnnotation).toBe('a');
    });
  });

  describe(GlyphComposerState.prototype.setDraft, () => {
    it('clears the document when the draft is emptied', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('text');
      composer.setDraft('');
      expect(composer.snapshot.document).toEqual({ parts: [], from: 0, to: 0, options: {} });
      expect(composer.snapshot.draft).toBe('');
    });
  });

  describe(GlyphComposerState.prototype.removeAnnotation, () => {
    it('stops editing the removed annotation and tolerates drafts without annotations', () => {
      const composer = new GlyphComposerState();
      composer.removeAnnotation('missing');
      expect(composer.snapshot.document.options?.annotations).toEqual([]);
      composer.saveAnnotation({
        id: 'a',
        order: 0,
        kind: 'chat',
        sourceId: 'chat',
        revision: '1',
        label: 'Chat',
        quote: 'quote',
        from: 0,
        to: 5,
        comment: 'Note',
      });
      composer.editAnnotation('a');
      composer.removeAnnotation('a');
      expect(composer.snapshot.editingAnnotation).toBeUndefined();
      expect(composer.snapshot.document.options?.annotations).toEqual([]);
    });
  });

  describe(GlyphComposerState.prototype.replaceAttachment, () => {
    it('swaps a capture in place without moving the selection', () => {
      const composer = new GlyphComposerState();
      const capture = {
        id: 'capture',
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///project/b.ts',
        path: 'b.ts',
        text: 'old',
        contentRevision: 'r1',
      };
      composer.setDocument({
        parts: [
          { type: 'text', text: 'ab' },
          { type: 'attachment', attachment: capture },
        ],
        from: 1,
        to: 2,
      });
      const refreshed = { ...capture, text: 'new', contentRevision: 'r2' };
      composer.replaceAttachment('capture', refreshed);
      expect(composer.snapshot.document).toEqual({
        parts: [
          { type: 'text', text: 'ab' },
          { type: 'attachment', attachment: refreshed },
        ],
        from: 1,
        to: 2,
        options: {},
      });
    });

    it('keeps the selection when the removed capture follows it', () => {
      const composer = new GlyphComposerState();
      const capture = {
        id: 'capture',
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///project/b.ts',
        path: 'b.ts',
        text: 'old',
        contentRevision: 'r1',
      };
      composer.setDocument({
        parts: [
          { type: 'text', text: 'ab' },
          { type: 'attachment', attachment: capture },
        ],
        from: 1,
        to: 2,
      });
      composer.replaceAttachment('capture');
      expect(composer.snapshot.document.parts).toEqual([{ type: 'text', text: 'ab' }]);
      expect(composer.snapshot.document.from).toBe(1);
      expect(composer.snapshot.document.to).toBe(2);
    });
  });

  describe(GlyphComposerState.prototype.mapAttachments, () => {
    it('leaves text parts untouched while mapping captures', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('look at ');
      composer.insertAttachments([attachment]);
      composer.mapAttachments(value => ({ ...value, path: 'renamed.ts' }));
      expect(composer.snapshot.draft).toBe('look at @renamed.ts (2-3)');
      expect(composer.snapshot.document.parts[0]).toEqual({ type: 'text', text: 'look at ' });
    });
  });

  describe(GlyphComposerState.prototype.editUnsent, () => {
    it('ignores indexes without an unsent draft', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('current');
      const before = composer.snapshot;
      composer.editUnsent(3);
      expect(composer.snapshot).toBe(before);
    });

    it('restores the chosen unsent draft without stashing an empty current draft', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('one');
      composer.restoreDraft({ parts: [{ type: 'text', text: 'two' }], from: 3, to: 3 });
      composer.restoreDraft({ parts: [{ type: 'text', text: 'three' }], from: 5, to: 5 });
      expect(composer.snapshot.unsent).toEqual(['one', 'two']);
      composer.setDraft('');
      composer.editUnsent(1);
      expect(composer.snapshot.draft).toBe('two');
      expect(composer.snapshot.unsent).toEqual(['one']);
    });
  });

  describe(GlyphComposerState.prototype.submit, () => {
    it('ignores blank drafts and submissions while another send is in flight', async () => {
      const composer = new GlyphComposerState();
      const send = vi.fn(async () => {});
      composer.setDraft('   ');
      await composer.submit(send);
      expect(send).not.toHaveBeenCalled();
      composer.setDraft('Hello');
      let finish!: () => void;
      const pending = composer.submit(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      composer.setDraft('Again');
      await composer.submit(send);
      expect(send).not.toHaveBeenCalled();
      finish();
      await pending;
      expect(composer.snapshot.submitting).toBe(false);
    });

    it('reports non-error rejections as text and restores the draft', async () => {
      const composer = new GlyphComposerState();
      composer.setDraft('Hello');
      await composer.submit(async () => {
        throw 'offline';
      });
      expect(composer.snapshot.error).toBe('offline');
      expect(composer.snapshot.draft).toBe('Hello');
    });
  });

  describe(GlyphComposerState.prototype.enqueueDraft, () => {
    it('ignores blank drafts and drafts typed while a direct send is in flight', async () => {
      const composer = new GlyphComposerState();
      composer.setDraft('  ');
      composer.enqueueDraft();
      expect(composer.snapshot.queued).toEqual([]);
      composer.setDraft('Direct');
      let finish!: () => void;
      const pending = composer.submit(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      composer.setDraft('Queued');
      composer.enqueueDraft();
      expect(composer.snapshot.queued).toEqual([]);
      finish();
      await pending;
    });
  });

  describe(GlyphComposerState.prototype.cancelQueueEdit, () => {
    it('does nothing when no queued message is being edited', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('Keep me');
      const before = composer.snapshot;
      composer.cancelQueueEdit();
      expect(composer.snapshot).toBe(before);
    });

    it('falls back to the default mode when the edited message had none', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('Queued');
      composer.enqueueDraft();
      composer.editQueued(composer.snapshot.queued[0]!.id);
      composer.cancelQueueEdit();
      expect(composer.snapshot.document).toEqual({
        parts: [],
        from: 0,
        to: 0,
        options: { mode: AgentModeID.AGENT },
      });
    });
  });

  describe(GlyphComposerState.prototype.removeQueued, () => {
    it('clears the draft and keeps the mode when removing the message being edited', () => {
      const composer = new GlyphComposerState();
      composer.setMode(AgentModeID.PLAN);
      composer.setDraft('Queued');
      composer.enqueueDraft();
      const id = composer.snapshot.queued[0]!.id;
      composer.editQueued(id);
      composer.removeQueued(id);
      expect(composer.snapshot.queued).toEqual([]);
      expect(composer.snapshot.editingQueuedMessage).toBeUndefined();
      expect(composer.snapshot.draft).toBe('');
      expect(composer.snapshot.document.options).toEqual({ mode: AgentModeID.PLAN });
    });

    it('falls back to the default mode when the removed edited message had none', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('Queued');
      composer.enqueueDraft();
      const id = composer.snapshot.queued[0]!.id;
      composer.editQueued(id);
      composer.removeQueued(id);
      expect(composer.snapshot.document.options).toEqual({ mode: AgentModeID.AGENT });
    });

    it('keeps editing another message when an unrelated entry is removed', () => {
      const composer = new GlyphComposerState();
      composer.setDraft('First');
      composer.enqueueDraft();
      composer.setDraft('Second');
      composer.enqueueDraft();
      const [first, second] = composer.snapshot.queued;
      composer.editQueued(first!.id);
      composer.removeQueued(second!.id);
      expect(composer.snapshot.editingQueuedMessage).toBe(first!.id);
      expect(composer.snapshot.draft).toBe('First');
    });
  });

  describe(GlyphComposerState.prototype.moveQueued, () => {
    it('ignores unknown messages and reordering while a message is being delivered', async () => {
      const composer = new GlyphComposerState();
      composer.setDraft('First');
      composer.enqueueDraft();
      composer.setDraft('Second');
      composer.enqueueDraft();
      const [first, second] = composer.snapshot.queued;
      composer.moveQueued('missing', 0);
      expect(composer.snapshot.queued.map(value => value.id)).toEqual([first!.id, second!.id]);
      let finish!: () => void;
      const pending = composer.sendQueued(
        first!.id,
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      );
      composer.moveQueued(second!.id, 0);
      expect(composer.snapshot.queued.map(value => value.id)).toEqual([first!.id, second!.id]);
      finish();
      await pending;
    });
  });

  describe(GlyphComposerState.prototype.pauseQueue, () => {
    it('stays unpaused when nothing is queued', () => {
      const composer = new GlyphComposerState();
      composer.pauseQueue();
      expect(composer.snapshot.queuePaused).toBe(false);
    });
  });

  describe(GlyphComposerState.prototype.sendQueued, () => {
    it('reports non-error rejections as text and pauses the queue', async () => {
      const composer = new GlyphComposerState();
      composer.setDraft('Queued');
      composer.enqueueDraft();
      await composer.sendQueued(composer.snapshot.queued[0]!.id, async () => {
        throw 'disconnected';
      });
      expect(composer.snapshot.queueError).toBe('disconnected');
      expect(composer.snapshot.queuePaused).toBe(true);
    });
  });
});

describe('queued composer documents', () => {
  it('discards canceled queue annotations without changing the queued message or the next send mode', async () => {
    const composer = new GlyphComposerState();
    composer.setMode(AgentModeID.PLAN);
    composer.setDraft('Revise this plan');
    composer.saveAnnotation({
      id: 'queued-annotation',
      order: 1,
      kind: 'plan',
      sourceId: 'plan',
      revision: '1',
      label: 'Plan',
      quote: 'source',
      from: 0,
      to: 6,
      comment: 'Only change the queued plan',
    });
    composer.enqueueDraft();
    const queued = structuredClone(composer.snapshot.queued[0]!);
    composer.editQueued(queued.id);
    composer.cancelQueueEdit();
    expect(composer.snapshot.queued).toEqual([queued]);
    expect(composer.snapshot.editingQueuedMessage).toBeUndefined();
    expect(composer.snapshot.document.options).toEqual({ mode: AgentModeID.PLAN });
    composer.setDraft('Explain an unrelated function');
    const send = vi.fn(async () => {});
    await composer.submit(send);
    expect(send).toHaveBeenCalledExactlyOnceWith('Explain an unrelated function', [], { mode: AgentModeID.PLAN });
  });
  it('reorders and edits exact attachment snapshots without consuming a newer draft', async () => {
    const composer = new GlyphComposerState();
    composer.setMode(AgentModeID.PLAN);
    composer.setDraft('Inspect ');
    composer.insertAttachments([attachment]);
    composer.enqueueDraft();
    const first = composer.snapshot.queued[0]!;
    composer.setDraft('Then verify');
    composer.enqueueDraft();
    const second = composer.snapshot.queued[1]!;
    composer.moveQueued(second.id, 0);
    expect(composer.snapshot.queued.map(value => value.id)).toEqual([second.id, first.id]);
    composer.setDraft('Unrelated current draft');
    composer.editQueued(first.id);
    expect(composer.snapshot.unsent).toEqual(['Unrelated current draft']);
    expect(composer.snapshot.document.parts).toEqual(first.document.parts);
    composer.setDocument({
      ...composer.snapshot.document,
      parts: [...composer.snapshot.document.parts, { type: 'text', text: ' carefully' }],
    });
    composer.enqueueDraft();
    expect(composer.snapshot.queued.map(value => value.id)).toEqual([second.id, first.id]);
    composer.setDraft('Keep this draft');
    await composer.sendQueued(first.id, async (text, attachments, options) => {
      expect(text).toBe('Inspect @a.ts (2-3) carefully');
      expect(attachments).toEqual([attachment]);
      expect(options?.mode).toBe(AgentModeID.PLAN);
      expect(options?.attachmentSpans).toEqual([{ from: 8, to: 19 }]);
    });
    expect(composer.snapshot.draft).toBe('Keep this draft');
    expect(composer.snapshot.queued.map(value => value.id)).toEqual([second.id]);
  });
  it('keeps failed queue entries in place and pauses automatic delivery until resumed', async () => {
    const composer = new GlyphComposerState();
    composer.setDraft('First');
    composer.enqueueDraft();
    composer.setDraft('Second');
    composer.enqueueDraft();
    const first = composer.snapshot.queued[0]!;
    await composer.sendQueued(first.id, async () => {
      throw new Error('Disconnected');
    });
    expect(composer.snapshot.queued.map(value => value.text)).toEqual(['First', 'Second']);
    expect(composer.snapshot.queuePaused).toBe(true);
    expect(composer.snapshot.queueError).toBe('Disconnected');
    composer.resumeQueue();
    expect(composer.snapshot.queuePaused).toBe(false);
    expect(composer.snapshot.queueError).toBeUndefined();
    composer.removeQueued(first.id);
    expect(composer.snapshot.queued.map(value => value.text)).toEqual(['Second']);
  });
  it('prevents double submission or editing an entry while it is being delivered', async () => {
    const composer = new GlyphComposerState();
    composer.setDraft('Only once');
    composer.enqueueDraft();
    const id = composer.snapshot.queued[0]!.id;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    let calls = 0;
    const send = async () => {
      calls++;
      await gate;
    };
    const pending = composer.sendQueued(id, send);
    await composer.sendQueued(id, send);
    composer.removeQueued(id);
    composer.editQueued(id);
    expect(composer.snapshot.queued).toHaveLength(1);
    expect(composer.snapshot.editingQueuedMessage).toBeUndefined();
    finish();
    await pending;
    expect(calls).toBe(1);
    expect(composer.snapshot.queued).toEqual([]);
  });
});

describe('turn context while a plan is building', () => {
  it('accepts a plain restored document without turn options', async () => {
    const composer = new GlyphComposerState();
    composer.setDocument({ parts: [{ type: 'text', text: 'Plain draft' }], from: 0, to: 0 });
    const send = vi.fn(async () => {});
    await composer.submit(send);
    expect(send).toHaveBeenCalledWith('Plain draft', [], {});
  });
  it('records build progress on messages sent or queued at that moment', async () => {
    const composer = new GlyphComposerState();
    let progress: { planId: string; title: string; completed: number; total: number } | undefined = {
      planId: 'plan',
      title: 'Queue composer messages',
      completed: 1,
      total: 4,
    };
    composer.provideTurnOptions(() => (progress ? { planProgress: progress } : undefined));
    composer.setDraft('Keep the order stable');
    composer.enqueueDraft();
    composer.setDraft('Also check edits');
    let sent: unknown;
    await composer.submit(async (_text, _attachments, options) => {
      sent = options?.planProgress;
    });
    progress = undefined;

    expect(sent).toEqual({ planId: 'plan', title: 'Queue composer messages', completed: 1, total: 4 });
    expect(composer.snapshot.queued[0]!.document.options?.planProgress).toEqual(sent);
  });

  it('drops progress from a queued message edited after the build finished', async () => {
    const composer = new GlyphComposerState();
    let building = true;
    composer.provideTurnOptions(() =>
      building ? { planProgress: { planId: 'plan', title: 'Plan', completed: 0, total: 2 } } : undefined,
    );
    composer.setDraft('Queued during the build');
    composer.enqueueDraft();
    building = false;
    const queued = composer.snapshot.queued[0]!;
    composer.editQueued(queued.id);
    composer.enqueueDraft();
    let sent: unknown = 'unset';
    await composer.sendQueued(queued.id, async (_text, _attachments, options) => {
      sent = options?.planProgress;
    });

    expect(sent).toBeUndefined();
  });
});
