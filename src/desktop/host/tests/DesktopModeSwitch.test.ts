import { AgentModeID } from '#src/chat/AgentMode.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';

const identity = { chatId: 'chat', runId: 'run' };
const request = {
  source: AgentModeID.PLAN,
  target: AgentModeID.AGENT,
  description: 'Implement the approved design.',
} as const;
function fixture(autoApprove = false) {
  vi.useFakeTimers();
  const events: GlyphHostEvent[] = [];
  const broker = new DesktopInteractionBroker(event => events.push(event));
  const controller = new AbortController();
  const apply = vi.fn(async () => {});
  const settle = vi.fn();
  const start = () =>
    broker.run({ ...identity, modeSwapPolicy: { autoApprove, timeoutSeconds: 5 } }, () =>
      broker.presentModeSwitch(request, controller.signal, apply, settle),
    );
  const answer = (decision: GlyphApprovalDecision, chatId = identity.chatId) => {
    const event = events[0];
    if (event?.type !== GlyphHostEventType.APPROVAL) throw new Error('Missing approval');
    broker.answer({ ...identity, chatId, id: event.approval.id, kind: 'approval', value: decision });
  };
  return { events, broker, controller, apply, settle, start, answer };
}
afterEach(() => vi.useRealTimers());
describe('Desktop mode switch approvals', () => {
  it.each([true, false])('uses the host deadline and the configured decision (autoApprove=%s)', async autoApprove => {
    const f = fixture(autoApprove);
    const result = f.start();
    expect(f.events[0]).toMatchObject({
      type: GlyphHostEventType.APPROVAL,
      approval: {
        modeSwap: {
          ...request,
          status: 'pending',
          autoApprove,
          startedAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() + 5000).toISOString(),
        },
      },
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.settle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(autoApprove);
    expect(f.apply).toHaveBeenCalledTimes(autoApprove ? 1 : 0);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(expect.any(String), autoApprove ? 'approved' : 'denied');
    expect(() => f.answer(GlyphApprovalDecision.ALLOW_ONCE)).toThrow('no longer pending');
  });
  it.each([GlyphApprovalDecision.ALLOW_ONCE, GlyphApprovalDecision.DENY])(
    'honors a manual %s once, ahead of the timer',
    async decision => {
      const f = fixture(decision === GlyphApprovalDecision.DENY);
      const result = f.start();
      expect(() => f.answer(GlyphApprovalDecision.ALLOW_ONCE, 'another-chat')).toThrow('no longer pending');
      expect(() => f.answer(GlyphApprovalDecision.ALWAYS_ALLOW)).toThrow();
      f.answer(decision);
      await expect(result).resolves.toBe(decision === GlyphApprovalDecision.ALLOW_ONCE);
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.settle).toHaveBeenCalledTimes(1);
      expect(f.apply).toHaveBeenCalledTimes(decision === GlyphApprovalDecision.ALLOW_ONCE ? 1 : 0);
    },
  );
  it('cancels the countdown without switching modes', async () => {
    const f = fixture(true);
    const result = f.start();
    const rejected = expect(result).rejects.toThrow('Stopped');
    f.controller.abort(new Error('Stopped'));
    await rejected;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'cancelled');
  });
  it('does not announce a switch if persisting the new mode fails', async () => {
    const f = fixture();
    f.apply.mockRejectedValue(new Error('Disk full'));
    const result = f.start();
    f.answer(GlyphApprovalDecision.ALLOW_ONCE);
    await expect(result).rejects.toThrow('Disk full');
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'failed');
  });
  it('starts the countdown only when a queued request is displayed', async () => {
    const f = fixture(true);
    const first = f.broker.run(identity, () =>
      f.broker.presentShellPermission({ command: 'test', workingDirectory: '/project' }, f.controller.signal),
    );
    const second = f.start();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.events).toHaveLength(1);
    f.answer(GlyphApprovalDecision.DENY);
    await first;
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe(true);
  });
});
