import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { WiredTerminalRoot } from '#src/terminal/ui/shell/TerminalRoot.wired.js';
import type { TerminalRendererSnapshot } from '#src/terminal/ui/shell/TerminalRendererSnapshot.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';

vi.mock('ink', async () => ({
  ...(await vi.importActual<typeof import('ink')>('ink')),
  useWindowSize: () => ({ columns: 100, rows: 24 }),
}));

const snapshot = (): TerminalRendererSnapshot => ({
  entries: [{ id: 1, content: <Text>{Array.from({ length: 40 }, (_, n) => `history ${n}`).join('\n')}</Text> }],
  responseParts: undefined,
  backgroundShells: [],
  review: undefined,
  prompt: { id: 2, label: 'you> ', acceptsSubmission: true, complete: vi.fn() },
  interrupt: vi.fn(),
});

describe(WiredTerminalRoot, () => {
  it('scrolls to the opening of a long question independently of option navigation', async () => {
    const state = snapshot();
    const complete = vi.fn();
    state.question = {
      id: 3,
      complete,
      interrupt: vi.fn(),
      form: {
        questions: [
          {
            id: 'long',
            allowMultiple: false,
            prompt:
              'IMPORTANT OPENING\n' +
              Array.from({ length: 35 }, (_, n) => `Detail ${n}: read this condition.`).join('\n'),
            options: [
              { id: 'yes', label: 'Proceed' },
              { id: 'no', label: 'Do not proceed' },
            ],
          },
        ],
      },
    };
    const view = render(<WiredTerminalRoot snapshot={state} />);
    try {
      await new Promise(resolve => {
        setTimeout(resolve, 30);
      });
      for (let n = 0; n < 4; n++) {
        view.stdin.write('\u001B[5~');
        await new Promise(resolve => {
          setTimeout(resolve, 30);
        });
      }
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('IMPORTANT OPENING');
      });
      expect(view.lastFrame()).not.toContain('history 0');
      expect(complete).not.toHaveBeenCalled();
      view.stdin.write('\r');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('› ● Proceed');
      });
      expect(complete).not.toHaveBeenCalled();
      view.stdin.write('\u001B[B');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('› ● Do not proceed');
      });
      view.stdin.write('\r');
      await vi.waitFor(() => {
        expect(complete).toHaveBeenCalledWith({
          answers: [{ questionId: 'long', type: QuestionAnswerType.SELECTION, optionIds: ['no'] }],
        });
      });
    } finally {
      view.unmount();
    }
  });
  it('keeps the composer visible with many background terminals and multiline commands', async () => {
    const state = snapshot();
    state.backgroundShells = Array.from({ length: 16 }, (_, n) => ({
      id: `terminal-${n}`,
      command: 'long command\n'.repeat(30),
      workingDirectory: '/fixture',
      status: ShellSessionStatus.RUNNING,
      background: true,
      outputTail: 'ready',
      startedAt: 'now',
    }));
    const view = render(<WiredTerminalRoot snapshot={state} />);
    try {
      await new Promise(resolve => {
        setTimeout(resolve, 20);
      });
      view.stdin.write('VISIBLE DRAFT');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('you> VISIBLE DRAFT');
      });
      expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(24);
      expect(view.lastFrame()).toContain('Background terminals (16)');
      view.stdin.write('\r');
      await vi.waitFor(() => {
        expect(state.prompt?.acceptsSubmission === true ? state.prompt.complete : undefined).toHaveBeenCalledWith({
          prompt: 'VISIBLE DRAFT',
          attachmentPaths: [],
        });
      });
    } finally {
      view.unmount();
    }
  });

  it('follows the caret to the end and back to the beginning of a long unsent prompt', async () => {
    const state = snapshot();
    const view = render(<WiredTerminalRoot snapshot={state} />);
    try {
      await new Promise(resolve => {
        setTimeout(resolve, 20);
      });
      view.stdin.write('START ' + 'draft '.repeat(450) + 'VISIBLE END');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('VISIBLE END');
      });
      expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(24);
      view.stdin.write('\u0001');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('you> START');
      });
      view.stdin.write('\u0005');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('VISIBLE END');
      });
      expect(state.prompt?.acceptsSubmission === true ? state.prompt.complete : undefined).not.toHaveBeenCalled();
      view.stdin.write('\r');
      await vi.waitFor(() => {
        expect(state.prompt?.acceptsSubmission === true ? state.prompt.complete : undefined).toHaveBeenCalledWith({
          prompt: 'START ' + 'draft '.repeat(450) + 'VISIBLE END',
          attachmentPaths: [],
        });
      });
    } finally {
      view.unmount();
    }
  });

  it('keeps the selected option and confirmation help visible when paging a thirty-option form', async () => {
    const state = snapshot();
    const complete = vi.fn();
    state.question = {
      id: 3,
      interrupt: vi.fn(),
      complete,
      form: {
        questions: [
          {
            id: 'choice',
            prompt: 'Choose a visible option',
            allowMultiple: false,
            options: Array.from({ length: 30 }, (_, n) => ({ id: `option-${n}`, label: `Option ${n + 1}` })),
          },
        ],
      },
    };
    const view = render(<WiredTerminalRoot snapshot={state} />);
    try {
      await new Promise(resolve => {
        setTimeout(resolve, 20);
      });
      for (let n = 0; n < 29; n++) {
        view.stdin.write('\u001B[B');
        await new Promise(resolve => {
          setTimeout(resolve, 5);
        });
      }
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('› ● Option 30');
      });
      expect(view.lastFrame()).toContain('Enter select');
      expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(24);
      view.stdin.write('\u001B[5~');
      await vi.waitFor(() => {
        expect(view.lastFrame()).not.toContain('› ● Option 30');
      });
      expect(view.lastFrame()).not.toContain('history 0');
      expect(complete).not.toHaveBeenCalled();
      view.stdin.write('\u001B[6~');
      await vi.waitFor(() => {
        expect(view.lastFrame()).toContain('› ● Option 30');
      });
      view.stdin.write('\r');
      await vi.waitFor(() => {
        expect(complete).toHaveBeenCalledWith({
          answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['option-29'] }],
        });
      });
    } finally {
      view.unmount();
    }
  });
});
