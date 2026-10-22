import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellPermissionMode } from '#src/shell/ShellPermissionPolicy.js';
import type { ShellPermissionStore } from '#src/shell/ShellPermissionStore.js';
import type { TerminalShellPermissionRequest } from '#src/terminal/ui/shell-permission/ShellPermissionRequest.js';
import { WiredShellPermission } from '#src/terminal/ui/shell-permission/ShellPermission.wired.js';
import { Box } from 'ink';

const terminalSize = vi.hoisted(() => ({ rows: 24, columns: 80 }));
vi.mock('ink', async () => ({
  ...(await vi.importActual<typeof import('ink')>('ink')),
  useWindowSize: () => terminalSize,
}));
afterEach(() => Object.assign(terminalSize, { rows: 24, columns: 80 }));

describe(WiredShellPermission, () => {
  describe('interaction', () => {
    it.each([
      { rows: 15, columns: 80 },
      { rows: 24, columns: 39 },
    ])('blocks approval but permits denial in a $columns by $rows terminal', async size => {
      Object.assign(terminalSize, size);
      const complete = vi.fn();
      const view = render(<WiredShellPermission request={request(complete)} />);
      try {
        expect(view.lastFrame()).toContain('Resize terminal');
        await write(view, '1');
        await write(view, '\r');
        expect(complete).not.toHaveBeenCalled();
        await writeEscape(view);
        expect(complete).toHaveBeenCalledExactlyOnceWith(ShellPermissionDecision.DENY);
      } finally {
        view.unmount();
      }
    });

    it('ignores key-release events instead of navigating, authorizing, or interrupting', async () => {
      const complete = vi.fn();
      const interrupt = vi.fn();
      const view = render(<WiredShellPermission request={{ ...request(complete), interrupt }} />);
      try {
        await write(view, '\u001B[1;1:3B');
        expect(view.lastFrame()).toContain('› 1. Allow once');
        view.stdin.write('\u001B[53;1:3u');
        view.stdin.write('\u001B[13;1:3u');
        view.stdin.write('\u001B[99;5:3u');
        await tick();
        expect(complete).not.toHaveBeenCalled();
        expect(interrupt).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it('denies without persisting unrestricted access when Down and Enter arrive before a render', async () => {
      let view: ReturnType<typeof render> | undefined;
      const save = vi.fn<ShellPermissionStore['save']>();
      const presentShellPermission = vi.fn(
        () =>
          new Promise<ShellPermissionDecision>(complete => {
            view?.unmount();
            view = render(<WiredShellPermission request={request(complete)} />);
          }),
      );
      const authorizer = new ShellCommandAuthorizer(
        'project',
        { load: async () => undefined, save },
        { presentShellPermission },
      );
      try {
        const authorization = authorizer.authorize('echo first', '/project', new AbortController().signal);
        const rejected = expect(authorization).rejects.toThrow('denied permission');
        await vi.waitFor(() => {
          expect(view).toBeDefined();
        });
        for (let index = 0; index < 4; index++) await write(view!, '\u001B[B');
        expect(view!.lastFrame()).toContain('› 5. Allow everything');
        view!.stdin.write('\u001B[B');
        view!.stdin.write('\r');
        await rejected;
        expect(save).not.toHaveBeenCalled();
        expect(authorizer.mode).toBe(ShellPermissionMode.ASK);

        const subsequent = authorizer.authorize('echo second', '/project', new AbortController().signal);
        const subsequentDenied = expect(subsequent).rejects.toThrow('denied permission');
        await vi.waitFor(() => {
          expect(presentShellPermission).toHaveBeenCalledTimes(2);
        });
        await write(view!, '6');
        await subsequentDenied;
        expect(save).not.toHaveBeenCalled();
      } finally {
        view?.unmount();
      }
    });

    it('accumulates rapid navigation and confirms the final permission choice', async () => {
      const complete = vi.fn();
      const view = render(<WiredShellPermission request={request(complete)} />);
      try {
        await tick();
        for (let index = 0; index < 5; index++) view.stdin.write('\u001B[B');
        view.stdin.write('\r');
        await tick();
        expect(complete).toHaveBeenCalledExactlyOnceWith(ShellPermissionDecision.DENY);
      } finally {
        view.unmount();
      }
    });

    it.each(['Enter', 'number', 'Escape'] as const)(
      'settles %s once and ignores later approval keys and interrupts',
      async submit => {
        const complete = vi.fn();
        const interrupt = vi.fn();
        const view = render(<WiredShellPermission request={{ ...request(complete), interrupt }} />);
        try {
          await tick();
          if (submit === 'Escape') await writeEscape(view);
          else view.stdin.write(submit === 'Enter' ? '\r' : '6');
          view.stdin.write('5');
          view.stdin.write('\r');
          view.stdin.write('\u0003');
          await tick();
          expect(complete).toHaveBeenCalledExactlyOnceWith(
            submit === 'Enter' ? ShellPermissionDecision.ALLOW_ONCE : ShellPermissionDecision.DENY,
          );
          expect(interrupt).not.toHaveBeenCalled();
        } finally {
          view.unmount();
        }
      },
    );

    it('does not authorize after interruption even when approval input arrives before a render', async () => {
      const complete = vi.fn();
      const interrupt = vi.fn();
      const view = render(<WiredShellPermission request={{ ...request(complete), interrupt }} />);
      try {
        await tick();
        view.stdin.write('\u0003');
        view.stdin.write('5');
        view.stdin.write('\r');
        view.stdin.write('\u0003');
        await tick();
        expect(interrupt).toHaveBeenCalledOnce();
        expect(complete).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    });

    it.each([false, true])(
      'resets selection and settlement for a replacement request after settled=%s',
      async settled => {
        const complete = vi.fn();
        const nextComplete = vi.fn();
        const view = render(<WiredShellPermission request={request(complete)} />);
        try {
          for (let index = 0; index < 4; index++) await write(view, '\u001B[B');
          expect(view.lastFrame()).toContain('› 5. Allow everything');
          if (settled) await write(view, '\r');
          view.rerender(<WiredShellPermission request={{ ...request(nextComplete), id: 2 }} />);
          await tick();
          expect(view.lastFrame()).toContain('› 1. Allow once');
          await write(view, '\r');
          expect(nextComplete).toHaveBeenCalledExactlyOnceWith(ShellPermissionDecision.ALLOW_ONCE);
          expect(complete).toHaveBeenCalledTimes(settled ? 1 : 0);
        } finally {
          view.unmount();
        }
      },
    );

    it('keeps the approval choice visible and pages through every line of a long command before Enter', async () => {
      const complete = vi.fn();
      const permission = {
        ...request(complete),
        permission: {
          command: Array.from({ length: 30 }, (_, n) => `echo harmless-${n}`).join('\n'),
          workingDirectory: '/project',
        },
      };
      const view = render(
        <Box height={24} overflow="hidden">
          <WiredShellPermission request={permission} />
        </Box>,
      );
      try {
        await vi.waitFor(() => {
          expect(view.lastFrame()).toContain('› 1. Allow once');
        });
        for (let n = 0; n < 10; n++) await write(view, '\u001B[6~');
        expect(view.lastFrame()).toContain('echo harmless-29');
        expect(view.lastFrame()).toContain('› 1. Allow once');
        for (let n = 0; n < 10; n++) await write(view, '\u001B[5~');
        expect(view.lastFrame()).toContain('echo harmless-0');
        expect(view.lastFrame()).not.toContain('echo harmless-29');
        expect(complete).not.toHaveBeenCalled();
        await write(view, '\r');
        expect(complete).toHaveBeenCalledWith(ShellPermissionDecision.ALLOW_ONCE);
      } finally {
        view.unmount();
      }
    });
    it('renders safely and selects each approval choice with arrows and Enter', async () => {
      const complete = vi.fn();
      const view = render(<WiredShellPermission request={request(complete)} />);

      expect(view.lastFrame()).toContain('Shell permission required');
      expect(view.lastFrame()).toContain('/project');
      expect(view.lastFrame()).toContain('echo danger');
      expect(view.lastFrame()).toContain('› 1. Allow once');
      await write(view, '\u001B[A');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
      await write(view, '\u001B[B');
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
      await write(inactive, '\u0003');
      expect(complete).not.toHaveBeenCalled();
      expect(interrupt).not.toHaveBeenCalled();
      inactive.unmount();

      const active = render(<WiredShellPermission request={{ ...request(complete), interrupt }} />);
      await write(active, 'x');
      await write(active, '0');
      await write(active, '7');
      await writeEscape(active);
      expect(complete).toHaveBeenCalledWith(ShellPermissionDecision.DENY);
      active.unmount();
    });
  });
});

function request(complete: TerminalShellPermissionRequest['complete']): TerminalShellPermissionRequest {
  return {
    id: 1,
    permission: { command: 'echo\u001B danger', workingDirectory: '/project' },
    complete,
    interrupt: vi.fn(),
  };
}

async function write(view: ReturnType<typeof render>, input: string): Promise<void> {
  view.stdin.write(input);
  await tick();
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

async function writeEscape(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write('\u001B');
  await new Promise<void>(resolve => {
    setTimeout(resolve, 75);
  });
}
