import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.ts';
import { BackgroundShells } from '../BackgroundShells.presentational.tsx';
import { WiredBackgroundShells } from '../BackgroundShells.wired.tsx';

describe(BackgroundShells, () => {
  describe('rendering', () => {
    it('renders nothing without background sessions', () => {
      const view = render(<BackgroundShells sessions={[]} />);

      expect(view.lastFrame()).toBe('');
      view.unmount();
    });

    it('renders running, idle, wake, sanitized, and recent-output state', () => {
      const sessions = [
        {
          id: 'terminal-running',
          workingDirectory: '/project',
          command: 'pnpm\u001b dev',
          status: ShellSessionStatus.RUNNING,
          background: true,
          outputTail: 'old\nready\n',
          startedAt: '2026-10-07T00:00:00.000Z',
          wakePattern: 'ready',
        },
        {
          id: 'terminal-idle',
          workingDirectory: '/project',
          command: '',
          status: ShellSessionStatus.IDLE,
          background: true,
          outputTail: '',
          startedAt: '2026-10-07T00:00:00.000Z',
        },
        {
          id: 'terminal-failed',
          workingDirectory: '/project',
          command: 'pnpm test',
          status: ShellSessionStatus.IDLE,
          background: true,
          outputTail: 'failed',
          startedAt: '2026-10-07T00:00:00.000Z',
          exitCode: 1,
        },
      ];
      const view = render(<WiredBackgroundShells sessions={sessions} />);

      expect(view.lastFrame()).toContain('Background terminals (3)');
      expect(view.lastFrame()).toContain('● terminal  pnpm dev  wake: ready  · ready');
      expect(view.lastFrame()).toContain('○ terminal  ready');
      expect(view.lastFrame()).toContain('× terminal  pnpm test  · failed');
      view.unmount();
    });
  });
});
