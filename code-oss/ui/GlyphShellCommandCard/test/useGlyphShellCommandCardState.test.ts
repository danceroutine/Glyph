import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { useGlyphShellCommandCardState } from '#code-oss/ui/GlyphShellCommandCard/useGlyphShellCommandCardState.ts';

const shellActivity = (shell: Partial<GlyphShellCommand> = {}, status = GlyphToolActivityStatus.STARTED) => ({
  id: 'tool',
  name: 'shell',
  status,
  shell: {
    command: 'npm test',
    output: 'one\ntwo\nthree\nfour\n\n',
    sessionId: 'session',
    background: false,
    live: true,
    running: true,
    ...shell,
  },
});

const detachedShellActivity = () => ({
  id: 'tool',
  name: 'shell',
  status: GlyphToolActivityStatus.STARTED,
  shell: { command: 'npm test', output: '', background: false, live: true, running: true },
});

const shellActions = () => ({
  writeShellInput: vi.fn(async (_chatId: string, _sessionId: string, _input: string, _appendNewline: boolean) => {}),
  stopShell: vi.fn(async (_chatId: string, _sessionId: string) => {}),
});

describe(useGlyphShellCommandCardState, () => {
  it('starts collapsed with a preview of the last output lines', () => {
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions: shellActions() },
    });

    expect(result.current.expanded).toBe(false);
    expect(result.current.preview).toBe('two\nthree\nfour');
    expect(result.current.input).toBe('');
    expect(result.current.appendNewline).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.disabled).toBe(false);
    expect(result.current.canSend).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(result.current.status).toBe('Running');
  });

  it.each([
    ['Interrupted', { running: true }, GlyphToolActivityStatus.INTERRUPTED, false],
    ['Running', { running: true }, GlyphToolActivityStatus.STARTED, false],
    ['Exit 0', { running: false, exitCode: 0 }, GlyphToolActivityStatus.COMPLETED, false],
    ['Failed · Exit 2', { running: false, exitCode: 2 }, GlyphToolActivityStatus.FAILED, true],
    ['Failed', { running: false, error: 'spawn failed' }, GlyphToolActivityStatus.FAILED, true],
    ['Idle', { running: false }, GlyphToolActivityStatus.COMPLETED, false],
    ['Waiting', { running: false, live: false }, GlyphToolActivityStatus.STARTED, false],
    ['Closed', { running: false, live: false, background: true }, GlyphToolActivityStatus.COMPLETED, false],
    ['Finished', { running: false, live: false }, GlyphToolActivityStatus.COMPLETED, false],
  ])('reports the status %s', (status, shell, activityStatus, failed) => {
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: {
        activity: shellActivity(shell, activityStatus),
        chatId: 'chat',
        readOnly: false,
        actions: shellActions(),
      },
    });

    expect(result.current.status).toBe(status);
    expect(result.current.failed).toBe(failed);
  });

  it('toggles between the preview and the full output', () => {
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions: shellActions() },
    });

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(true);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(false);
  });

  it('sends input to the running shell and clears it', async () => {
    const actions = shellActions();
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions },
    });
    act(() => {
      result.current.changeInput('yes');
    });
    act(() => {
      result.current.changeAppendNewline(false);
    });

    await act(async () => {
      result.current.sendInput();
    });

    expect(actions.writeShellInput).toHaveBeenCalledWith('chat', 'session', 'yes', false);
    expect(result.current.input).toBe('');
  });

  it('can only send something to a running live shell from the owning window', () => {
    const cases = [
      { shell: { live: false }, readOnly: false },
      { shell: { running: false }, readOnly: false },
      { shell: {}, readOnly: true },
    ];

    expect(
      cases.map(({ shell, readOnly }) => {
        const { result } = renderHook(useGlyphShellCommandCardState, {
          initialProps: { activity: shellActivity(shell), chatId: 'chat', readOnly, actions: shellActions() },
        });
        return result.current.canSend;
      }),
    ).toEqual([false, false, false]);
  });

  it('can send an empty line only when appending a newline', () => {
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions: shellActions() },
    });

    act(() => {
      result.current.changeAppendNewline(false);
    });
    expect(result.current.canSend).toBe(false);

    act(() => {
      result.current.changeInput('y');
    });
    expect(result.current.canSend).toBe(true);
  });

  it('does not send input to a shell that is not running or has no session', async () => {
    const actions = shellActions();
    const stopped = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity({ running: false }), chatId: 'chat', readOnly: false, actions },
    });
    const detached = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: detachedShellActivity(), chatId: 'chat', readOnly: false, actions },
    });

    await act(async () => {
      stopped.result.current.sendInput();
    });
    await act(async () => {
      detached.result.current.sendInput();
    });

    expect(actions.writeShellInput).not.toHaveBeenCalled();
  });

  it('closes the shell and keeps the typed input', async () => {
    const actions = shellActions();
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions },
    });
    act(() => {
      result.current.changeInput('draft');
    });

    await act(async () => {
      result.current.close();
    });

    expect(actions.stopShell).toHaveBeenCalledWith('chat', 'session');
    expect(result.current.input).toBe('draft');
  });

  it('cannot close a shell without a session', async () => {
    const actions = shellActions();
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: detachedShellActivity(), chatId: 'chat', readOnly: false, actions },
    });

    await act(async () => {
      result.current.close();
    });

    expect(actions.stopShell).not.toHaveBeenCalled();
  });

  it('ignores shell actions from a read-only window or for a shell that is no longer live', async () => {
    const actions = shellActions();
    const readOnly = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: true, actions },
    });
    const ended = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity({ live: false }), chatId: 'chat', readOnly: false, actions },
    });

    await act(async () => {
      readOnly.result.current.close();
    });
    await act(async () => {
      ended.result.current.close();
    });

    expect(readOnly.result.current.disabled).toBe(true);
    expect(actions.stopShell).not.toHaveBeenCalled();
  });

  it('runs one shell action at a time', async () => {
    const actions = shellActions();
    let finish!: () => void;
    actions.stopShell.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions },
    });

    act(() => {
      result.current.close();
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.disabled).toBe(true);
    expect(result.current.canSend).toBe(false);

    await act(async () => {
      result.current.sendInput();
    });
    expect(actions.writeShellInput).not.toHaveBeenCalled();

    await act(async () => {
      finish();
    });
    expect(result.current.pending).toBe(false);
  });

  it('reports failed shell actions until the next attempt', async () => {
    const actions = shellActions();
    actions.stopShell.mockRejectedValueOnce(new Error('Gone')).mockRejectedValueOnce('Refused');
    const { result } = renderHook(useGlyphShellCommandCardState, {
      initialProps: { activity: shellActivity(), chatId: 'chat', readOnly: false, actions },
    });

    await act(async () => {
      result.current.close();
    });
    expect(result.current.error).toBe('Gone');

    await act(async () => {
      result.current.close();
    });
    expect(result.current.error).toBe('Refused');

    await act(async () => {
      result.current.close();
    });
    expect(result.current.error).toBeUndefined();
  });
});
