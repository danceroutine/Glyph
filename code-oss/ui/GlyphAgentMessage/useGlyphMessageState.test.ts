import { act, cleanup, renderHook, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphContextActions } from '#src/desktop/workbench/GlyphContextActions.js';
import { useGlyphMessageState } from '#code-oss/ui/GlyphAgentMessage/useGlyphMessageState.ts';

afterEach(cleanup);

function transcriptEntry(overrides: Partial<GlyphTranscriptEntry> = {}): GlyphTranscriptEntry {
  return { id: 'entry-1', role: GlyphTranscriptRole.ASSISTANT, text: 'Hello', ...overrides };
}

function contextActions(openAttachment: GlyphContextActions['openAttachment']) {
  return { openAttachment } as Partial<GlyphContextActions> as GlyphContextActions;
}

describe(useGlyphMessageState, () => {
  it('labels each speaker', () => {
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [
          transcriptEntry({ id: 'u', role: GlyphTranscriptRole.USER }),
          transcriptEntry({ id: 'a', role: GlyphTranscriptRole.ASSISTANT }),
          transcriptEntry({ id: 'd', role: GlyphTranscriptRole.DIAGNOSTIC }),
        ],
      },
    });

    expect(result.current.entries.map(entry => entry.label)).toEqual(['You', 'Glyph', 'Status']);
  });

  it('formats valid creation times only', () => {
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [
          transcriptEntry({ id: 'dated', createdAt: '2026-10-20T12:00:00Z' }),
          transcriptEntry({ id: 'invalid', createdAt: 'not a date' }),
          transcriptEntry({ id: 'undated' }),
        ],
      },
    });

    expect(result.current.entries.map(entry => entry.datetime)).toEqual([
      new Date('2026-10-20T12:00:00Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      undefined,
      undefined,
    ]);
  });

  it('splits text around attachment mentions with readable labels', () => {
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [
          transcriptEntry({
            text: 'See @src/a.ts (3-5) and @README.md',
            attachments: [
              {
                path: 'src/a.ts',
                text: 'a',
                revision: 'r1',
                range: { start: { line: 3, column: 0 }, end: { line: 5, column: 0 } },
              },
              { path: 'README.md', text: 'b', revision: 'r2' },
            ],
          }),
        ],
      },
    });

    expect(
      result.current.entries[0]!.parts.map(part =>
        part.type === 'text' ? part.text : `[${part.label}|${part.title}]`,
      ),
    ).toEqual(['See ', '[a.ts (3-5)|src/a.ts (3-5)]', ' and ', '[README.md|README.md]']);
  });

  it('separates shell commands from other tool activity', () => {
    const shell = { command: 'ls', output: '', background: false, live: false, running: false };
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [
          transcriptEntry({
            progress: {
              status: GlyphRunStatus.COMPLETED,
              reasoning: '',
              tools: [
                { id: 't1', name: 'read', status: GlyphToolActivityStatus.COMPLETED },
                { id: 't2', name: 'shell', status: GlyphToolActivityStatus.COMPLETED, shell },
              ],
            },
          }),
          transcriptEntry({ id: 'plain' }),
        ],
      },
    });

    const [withTools, plain] = result.current.entries;
    expect(withTools!.progress!.tools.map(tool => tool.id)).toEqual(['t1']);
    expect(withTools!.shellActivities.map(tool => tool.id)).toEqual(['t2']);
    expect(plain!.progress).toBeUndefined();
    expect(plain!.shellActivities).toEqual([]);
  });

  it('offers history actions only for checkpointed entries', () => {
    const branch = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [transcriptEntry({ id: 'saved', checkpointTurnId: 'turn-1' }), transcriptEntry({ id: 'draft' })],
        branch,
        restore,
      },
    });

    const [saved, draft] = result.current.entries;
    expect(saved!.branch).toBeTypeOf('function');
    expect(saved!.restore).toBeTypeOf('function');
    expect(draft!.branch).toBeUndefined();
    expect(draft!.restore).toBeUndefined();
  });

  it('runs one history action at a time', async () => {
    let finish!: () => void;
    const branch = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    const restore = vi.fn(async () => {});
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: { entries: [transcriptEntry({ checkpointTurnId: 'turn-1' })], branch, restore },
    });

    act(() => result.current.entries[0]!.branch!());
    expect(result.current.entries[0]!.historyPending).toBe(true);
    act(() => result.current.entries[0]!.restore!());
    expect(restore).not.toHaveBeenCalled();
    act(() => finish());
    await waitFor(() => expect(result.current.entries[0]!.historyPending).toBe(false));
    act(() => result.current.entries[0]!.restore!());

    expect(branch).toHaveBeenCalledWith('turn-1');
    expect(restore).toHaveBeenCalledWith('turn-1');
  });

  it('reports failed history actions on their entry', async () => {
    const branch = vi.fn().mockRejectedValueOnce(new Error('Branch failed')).mockRejectedValueOnce('Offline');
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: {
        entries: [transcriptEntry({ checkpointTurnId: 'turn-1' }), transcriptEntry({ id: 'other' })],
        branch,
      },
    });

    act(() => result.current.entries[0]!.branch!());
    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Branch failed'));
    expect(result.current.entries[1]!.attachmentError).toBeUndefined();
    act(() => result.current.entries[0]!.branch!());

    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Offline'));
  });

  it('opens attachments and reports failures', async () => {
    const openAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error('Missing file'))
      .mockRejectedValueOnce('Denied')
      .mockResolvedValueOnce(undefined);
    const attachment = { path: 'a.ts', text: 'a', revision: 'r' };
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: { entries: [transcriptEntry()], context: contextActions(openAttachment) },
    });

    act(() => result.current.entries[0]!.openAttachment(attachment));
    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Missing file'));
    act(() => result.current.entries[0]!.openAttachment(attachment));
    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Denied'));
    act(() => result.current.entries[0]!.openAttachment(attachment));

    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBeUndefined());
    expect(openAttachment).toHaveBeenCalledWith(attachment);
  });

  it('ignores attachments without a context to open them', async () => {
    const { result } = renderHook(useGlyphMessageState, { initialProps: { entries: [transcriptEntry()] } });

    await act(async () => result.current.entries[0]!.openAttachment({ path: 'a.ts', text: 'a', revision: 'r' }));

    expect(result.current.entries[0]!.attachmentError).toBeUndefined();
  });

  it('copies message text through the provided clipboard', async () => {
    const copyText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('No clipboard'));
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: { entries: [transcriptEntry({ text: 'Copy me' })], copyText },
    });

    act(() => result.current.entries[0]!.copy());
    expect(copyText).toHaveBeenCalledWith('Copy me');
    expect(result.current.entries[0]!.copyText).toBe(copyText);
    act(() => result.current.entries[0]!.copy());

    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Error: No clipboard'));
  });

  it('copies message text through the system clipboard by default', () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    onTestFinished(() => write.mockRestore());
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: { entries: [transcriptEntry({ text: 'System copy' })] },
    });

    act(() => result.current.entries[0]!.copy());

    expect(write).toHaveBeenCalledWith('System copy');
  });

  it('opens links through the host when it handles them', async () => {
    const openLink = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Blocked'));
    const { result } = renderHook(useGlyphMessageState, { initialProps: { entries: [transcriptEntry()], openLink } });

    act(() => result.current.entries[0]!.openLink('https://example.com'));
    act(() => result.current.entries[0]!.openLink('src/a.ts'));

    expect(openLink.mock.calls).toEqual([['https://example.com'], ['src/a.ts']]);
    await waitFor(() => expect(result.current.entries[0]!.attachmentError).toBe('Error: Blocked'));
  });

  it('opens web links in a new window and other links as files', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    onTestFinished(() => open.mockRestore());
    const openAttachment = vi.fn(async () => {});
    const { result } = renderHook(useGlyphMessageState, {
      initialProps: { entries: [transcriptEntry()], context: contextActions(openAttachment) },
    });

    act(() => result.current.entries[0]!.openLink('HTTPS://example.com/page'));
    act(() => result.current.entries[0]!.openLink('docs/guide.md'));

    expect(open).toHaveBeenCalledWith('HTTPS://example.com/page', '_blank', 'noopener,noreferrer');
    expect(openAttachment).toHaveBeenCalledWith({ path: 'docs/guide.md' });
  });

  it('ignores file links without a context to open them', async () => {
    const { result } = renderHook(useGlyphMessageState, { initialProps: { entries: [transcriptEntry()] } });

    await act(async () => result.current.entries[0]!.openLink('docs/guide.md'));

    expect(result.current.entries[0]!.attachmentError).toBeUndefined();
  });
});
