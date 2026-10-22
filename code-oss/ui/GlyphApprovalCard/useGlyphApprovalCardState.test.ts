import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { useGlyphApprovalCardState } from '#code-oss/ui/GlyphApprovalCard/useGlyphApprovalCardState.ts';

afterEach(cleanup);

describe(useGlyphApprovalCardState, () => {
  it('submits each decision for the pending request', async () => {
    const decideApproval = vi.fn(async () => {});
    const request = { id: 'approval-1', title: 'Run command', detail: 'ls', sandboxed: true };
    const decisions = [
      ['skip', GlyphApprovalDecision.DENY],
      ['alwaysRun', GlyphApprovalDecision.ALWAYS_ALLOW],
      ['run', GlyphApprovalDecision.ALLOW_ONCE],
    ] as const;

    for (const [choice, decision] of decisions) {
      const { result, unmount } = renderHook(useGlyphApprovalCardState, {
        initialProps: { request, chatId: 'chat-1', runId: 'run-1', actions: { decideApproval }, disabled: false },
      });
      await act(async () => {
        result.current[choice]();
      });
      expect(decideApproval).toHaveBeenLastCalledWith('chat-1', 'run-1', 'approval-1', decision);
      expect(result.current.pending).toBe(true);
      unmount();
    }
  });

  it('submits nothing while disabled', async () => {
    const decideApproval = vi.fn(async () => {});
    const { result } = renderHook(useGlyphApprovalCardState, {
      initialProps: {
        request: { id: 'approval-1', title: 'Run command', detail: 'ls', sandboxed: true },
        chatId: 'chat-1',
        runId: 'run-1',
        actions: { decideApproval },
        disabled: true,
      },
    });

    await act(async () => {
      result.current.run();
    });

    expect(decideApproval).not.toHaveBeenCalled();
    expect(result.current.disabled).toBe(true);
    expect(result.current.pending).toBe(false);
  });

  it('surfaces failed decisions so they can be retried', async () => {
    const decideApproval = vi.fn().mockRejectedValueOnce(new Error('Approval expired'));
    const { result } = renderHook(useGlyphApprovalCardState, {
      initialProps: {
        request: { id: 'approval-1', title: 'Run command', detail: 'ls', sandboxed: true },
        chatId: 'chat-1',
        runId: 'run-1',
        actions: { decideApproval },
        disabled: false,
      },
    });

    await act(async () => {
      result.current.run();
    });

    expect(result.current.error).toBe('Approval expired');
    expect(result.current.pending).toBe(false);
  });
});
