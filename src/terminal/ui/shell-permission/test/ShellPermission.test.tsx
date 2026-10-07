import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.ts';
import type { TerminalShellPermissionRequest } from '../ShellPermissionRequest.ts';
import { WiredShellPermission } from '../ShellPermission.wired.tsx';

describe(WiredShellPermission, () => {
  describe('interaction', () => {
    it('renders safely and selects each approval choice with arrows and Enter', async () => {
      const complete = vi.fn();
      const view = render(<WiredShellPermission request={request(complete)} />);

      expect(view.lastFrame()).toContain('Shell permission required');
      expect(view.lastFrame()).toContain('/project');
      expect(view.lastFrame()).toContain('echo danger');
      expect(view.lastFrame()).toContain('› 1. Allow once');
      await write(view, '\x1b[A');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\x1b[B');
      await write(view, '\r');

      expect(complete).toHaveBeenCalledWith(ShellPermissionDecision.DENY);
      view.unmount();
    });

    it.each([
      ['1', ShellPermissionDecision.ALLOW_ONCE],
      ['2', ShellPermissionDecision.ALWAYS_ALLOW],
      ['3', ShellPermissionDecision.ALLOW_SAFE],
      ['4', ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE],
      ['5', ShellPermissionDecision.ALLOW_EVERYTHING],
      ['6', ShellPermissionDecision.DENY],
    ])('selects numeric choice %s', async (input, decision) => {
      const complete = vi.fn();
      const view = render(<WiredShellPermission request={request(complete)} />);

      await write(view, input);

      expect(complete).toHaveBeenCalledWith(decision);
      view.unmount();
    });

    it('denies with Escape, forwards Ctrl+C, ignores invalid keys, and can be inactive', async () => {
      const complete = vi.fn();
      const interrupt = vi.fn();
      const inactive = render(<WiredShellPermission request={{ ...request(complete), interrupt }} active={false} />);
      await write(inactive, '2');
      await write(inactive, '\x03');
      expect(complete).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
      inactive.unmount();

      const active = render(<WiredShellPermission request={{ ...request(complete), interrupt }} />);
      await write(active, 'x');
      await write(active, '0');
      await write(active, '7');
      await write(active, '\x03');
      expect(interrupt).toHaveBeenCalledOnce();
      await writeEscape(active);
      expect(complete).toHaveBeenCalledWith(ShellPermissionDecision.DENY);
      active.unmount();
    });
  });
});

function request(complete: TerminalShellPermissionRequest['complete']): TerminalShellPermissionRequest {
  return {
    id: 1,
    permission: { command: 'echo\u001b danger', workingDirectory: '/project' },
    complete,
    interrupt: vi.fn(),
  };
}

async function write(view: ReturnType<typeof render>, input: string): Promise<void> {
  view.stdin.write(input);
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function writeEscape(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write('\x1b');
  await new Promise<void>(resolve => setTimeout(resolve, 75));
}
