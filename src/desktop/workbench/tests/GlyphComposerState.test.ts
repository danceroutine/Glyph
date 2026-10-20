import { AgentModeID } from '#src/chat/AgentMode.js';
import { describe, expect, it } from 'vitest';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
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
});

describe('queued composer documents', () => {
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
