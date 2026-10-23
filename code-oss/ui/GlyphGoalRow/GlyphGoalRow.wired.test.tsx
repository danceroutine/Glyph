import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import type { GlyphGoal } from '#src/desktop/protocol/events/GlyphGoal.js';
import { WiredGlyphGoalRow } from './GlyphGoalRow.wired.tsx';
import { formatGoalDuration, useGlyphGoalRowState, type GlyphGoalRowState } from './useGlyphGoalRowState.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const goal = (changes: Partial<GlyphGoal> = {}): GlyphGoal => ({
  id: 'goal',
  objective: 'Ship the feature',
  status: 'active',
  createdAt: '2026-10-20T14:00:00.000Z',
  activeSince: '2026-10-20T14:00:00.000Z',
  continuationCount: 0,
  idleContinuationsWithoutToolCalls: 0,
  activeDurationMs: 2000,
  ...changes,
});
const actions = () => ({
  pauseGoal: vi.fn(async () => {}),
  resumeGoal: vi.fn(async () => {}),
  clearGoal: vi.fn(async () => {}),
});

it.each([
  [-1000, '0s'],
  [59000, '59s'],
  [65000, '1m 5s'],
  [3725000, '1h 2m'],
])('formats %i milliseconds as %s', (duration, expected) => {
  expect(formatGoalDuration(duration)).toBe(expected);
});

it('ticks only while active, pauses the exact goal, and clears it', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T14:00:03.000Z'));
  const host = actions();
  const view = render(<WiredGlyphGoalRow chatId="chat" goal={goal()} readOnly={false} actions={host} />);
  expect(screen.getByLabelText('Worked for 5s')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByLabelText('Worked for 6s')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
  });
  expect(host.pauseGoal).toHaveBeenCalledWith('chat', 'goal');
  const { activeSince: _activeSince, ...paused } = goal({ status: 'paused' });
  view.rerender(<WiredGlyphGoalRow chatId="chat" goal={paused} readOnly={false} actions={host} />);
  expect(screen.getByText('Paused · Stopped')).toBeTruthy();
  expect(screen.getByLabelText('Worked for 2s')).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByLabelText('Worked for 2s')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume goal' }));
  });
  expect(host.resumeGoal).toHaveBeenCalledWith('chat', 'goal');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
  });
  expect(host.clearGoal).toHaveBeenCalledWith('chat', 'goal');
});

it.each([
  ['failed', 'Paused · Run failed'],
  ['stalled', 'Paused · No progress'],
] as const)('explains the %s pause and prevents read-only actions', (pauseReason, label) => {
  const host = actions();
  render(<WiredGlyphGoalRow chatId="chat" goal={goal({ status: 'paused', pauseReason })} readOnly actions={host} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Resume goal' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear goal' }).disabled).toBe(true);
});

it('keeps a completed objective visible without a resume action', () => {
  render(<WiredGlyphGoalRow chatId="chat" goal={goal({ status: 'complete' })} readOnly={false} actions={actions()} />);
  expect(screen.getByText('Complete')).toBeTruthy();
  expect(screen.getByTitle('Ship the feature')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Resume goal' })).toBeNull();
});

it.each([new Error('Offline'), 'Offline'])('reports failures and permits a retry: %s', async failure => {
  const host = actions();
  host.pauseGoal.mockRejectedValueOnce(failure);
  render(<WiredGlyphGoalRow chatId="chat" goal={goal()} readOnly={false} actions={host} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toBe('Offline');
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pause goal' }));
  await waitFor(() => {
    expect(screen.queryByRole('alert')).toBeNull();
  });
  expect(host.pauseGoal).toHaveBeenCalledTimes(2);
});

it('coalesces actions until the outstanding host request settles', async () => {
  const host = actions();
  let finish!: () => void;
  host.pauseGoal.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      }),
  );
  let state!: GlyphGoalRowState;
  const now = () => Date.parse('2026-10-20T14:00:01.000Z');
  function Harness() {
    state = useGlyphGoalRowState({ chatId: 'chat', goal: goal(), readOnly: false, actions: host, now });
    return null;
  }
  render(<Harness />);
  act(() => {
    state.toggle();
    state.clear();
  });
  expect(state.pending).toBe(true);
  expect(state.disabled).toBe(true);
  expect(host.pauseGoal).toHaveBeenCalledTimes(1);
  expect(host.clearGoal).not.toHaveBeenCalled();
  await act(async () => {
    finish();
  });
  expect(state.pending).toBe(false);
  expect(state.disabled).toBe(false);
});
