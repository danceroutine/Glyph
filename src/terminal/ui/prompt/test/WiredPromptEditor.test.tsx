import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.ts';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.ts';
import { TERMINAL_COMMANDS } from '#src/terminal/TerminalCommand.ts';
import { WiredPromptEditor } from '../PromptEditor.wired.tsx';

describe(WiredPromptEditor, () => {
  describe('interaction', () => {
    it('submits printable and pasted text', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, 'hello');
      await write(view, '\x1b[200~ world\nagain\x1b[201~');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({ prompt: 'hello world again', attachmentPaths: [] });
      view.unmount();
    });

    it('accepts draft input but ignores Enter while submission is disabled', async () => {
      const view = render(
        <WiredPromptEditor request={{ id: 1, label: 'you> ', acceptsSubmission: false }} interrupt={vi.fn()} />,
      );

      await write(view, 'follow-up');
      view.stdin.write('\r');
      await tick();

      expect(view.lastFrame()).toContain('Agent responding · draft only');
      expect(view.lastFrame()).toContain('you> follow-up');
      view.unmount();
    });

    it('lists every slash command, filters, navigates, and completes with Tab', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, '/');
      for (const command of TERMINAL_COMMANDS) expect(view.lastFrame()).toContain(command.value);

      await write(view, 'tr');
      expect(view.lastFrame()).toContain('/trace off');
      expect(view.lastFrame()).not.toContain('/help');
      await write(view, '\x1b[B');
      await write(view, '\t');
      expect(view.lastFrame()).toContain('you> /trace on');
      expect(view.lastFrame()).not.toContain('Enable full provider tracing');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({ prompt: '/trace on', attachmentPaths: [] });
      view.unmount();
    });

    it('executes the selected slash command with Enter', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, '/rev');
      expect(view.lastFrame()).toContain('Resume pending edit review');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({ prompt: '/review', attachmentPaths: [] });
      view.unmount();
    });

    it('dismisses slash completion with Escape and reopens it when typing resumes', async () => {
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete: vi.fn() }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, '/');
      expect(view.lastFrame()).toContain('Show commands and keyboard help');
      await writeEscape(view);
      expect(view.lastFrame()).not.toContain('Show commands and keyboard help');
      await write(view, 'r');
      expect(view.lastFrame()).toContain('Clear the current conversation');
      expect(view.lastFrame()).not.toContain('/help');
      view.unmount();
    });

    it('searches, navigates, and attaches safe matches with Tab', async () => {
      const complete = vi.fn();
      const search = vi.fn<WorkspacePathIndex['search']>(async (query, { generation }) => ({
        generation,
        query,
        fileCount: 3,
        matches: [
          { path: 'src/first.ts', score: 20, indices: [4] },
          { path: 'src/second.ts', score: 10, indices: [4] },
          { path: 'src/unsafe\u0000.ts', score: 5, indices: [] },
        ],
      }));
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, files: fileSearch(search), complete }}
          interrupt={vi.fn()}
        />,
      );

      view.stdin.write('@app');
      await waitUntil(() => (view.lastFrame() ?? '').includes('src/second.ts'));
      view.stdin.write('\x1b[B');
      view.stdin.write('\x1b[B');
      view.stdin.write('\x1b[A');
      await tick();
      view.stdin.write('\t');
      await waitUntil(() => (view.lastFrame() ?? '').includes('@first.ts'));
      expect(view.lastFrame()).not.toContain('src/first.ts');
      await write(view, '\x1b[D');
      expect(view.lastFrame()).toContain('@src/first.ts');
      await write(view, '\x1b[C');
      expect(view.lastFrame()).not.toContain('@src/first.ts');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(search).toHaveBeenCalled();
      expect(view.lastFrame()).not.toContain('unsafe');
      expect(complete).toHaveBeenCalledWith({
        prompt: '@src/first.ts',
        attachmentPaths: ['src/first.ts'],
      });
      view.unmount();
    });

    it('preserves one attachment when the same path is attached twice', async () => {
      const complete = vi.fn();
      const search = vi.fn<WorkspacePathIndex['search']>(async (query, { generation }) => ({
        generation,
        query,
        fileCount: 1,
        matches: [{ path: 'src/App.tsx', score: 1, indices: [] }],
      }));
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, files: fileSearch(search), complete }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, 'x@src/App.tsx @app');
      await waitUntil(() => (view.lastFrame() ?? '').includes('src/App.tsx'));
      await write(view, '\t');
      await write(view, '@app');
      await waitUntil(() => search.mock.calls.length >= 2);
      await write(view, '\t');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete.mock.calls[0]?.[0].attachmentPaths).toEqual(['src/App.tsx']);
      view.unmount();
    });

    it('dismisses an active mention and ignores Escape without one', async () => {
      const search = vi.fn<WorkspacePathIndex['search']>(async (query, { generation }) => ({
        generation,
        query,
        fileCount: 1,
        matches: [{ path: 'src/App.tsx', score: 1, indices: [] }],
      }));
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, files: fileSearch(search), complete: vi.fn() }}
          interrupt={vi.fn()}
        />,
      );

      await writeEscape(view);
      await write(view, '@app');
      await waitUntil(() => (view.lastFrame() ?? '').includes('src/App.tsx'));
      await writeEscape(view);
      await waitUntil(() => !(view.lastFrame() ?? '').includes('src/App.tsx'));

      expect(view.lastFrame()).toContain('@app');
      view.unmount();
    });

    it('supports cursor movement and deletion across surrogate pairs', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete }}
          interrupt={vi.fn()}
        />,
      );

      for (const input of [
        'a😀b',
        '\x1b[D',
        '\x7f',
        '\x1b[C',
        '\x1b[C',
        '\x1b[3~',
        '\x1b[H',
        '\x7f',
        '\x1b[3~',
        '\x05',
        '\x01',
        'z',
      ]) {
        await write(view, input);
      }
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({ prompt: 'zb', attachmentPaths: [] });
      view.unmount();
    });

    it('moves right across a surrogate pair and supports Ctrl+D forward deletion', async () => {
      const complete = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, '😀b');
      await write(view, '\x1b[H');
      await write(view, '\x1b[C');
      await write(view, 'x');
      await write(view, '\x04');
      view.stdin.write('\r');
      await waitUntil(() => complete.mock.calls.length === 1);

      expect(complete).toHaveBeenCalledWith({ prompt: '😀x', attachmentPaths: [] });
      view.unmount();
    });

    it('reports ordinary search failures and silences cancellation failures', async () => {
      const ordinary = render(
        <WiredPromptEditor
          request={{
            id: 1,
            label: 'you> ',
            acceptsSubmission: true,
            files: fileSearch(async () => {
              throw 'broken';
            }),
            complete: vi.fn(),
          }}
          interrupt={vi.fn()}
        />,
      );
      ordinary.stdin.write('@app');
      await waitUntil(() => (ordinary.lastFrame() ?? '').includes('File search: File search failed.'));
      ordinary.unmount();

      const errorFailure = render(
        <WiredPromptEditor
          request={{
            id: 2,
            label: 'you> ',
            acceptsSubmission: true,
            files: fileSearch(async () => {
              throw new Error('broken');
            }),
            complete: vi.fn(),
          }}
          interrupt={vi.fn()}
        />,
      );
      errorFailure.stdin.write('@app');
      await waitUntil(() => (errorFailure.lastFrame() ?? '').includes('File search: broken'));
      errorFailure.unmount();

      for (const error of [
        new WorkspacePathIndexError(WorkspacePathIndexFailureReason.SUPERSEDED, 'old'),
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ]) {
        const cancelled = render(
          <WiredPromptEditor
            request={{
              id: 2,
              label: 'you> ',
              acceptsSubmission: true,
              files: fileSearch(async () => {
                throw error;
              }),
              complete: vi.fn(),
            }}
            interrupt={vi.fn()}
          />,
        );
        cancelled.stdin.write('@app');
        await tick();
        expect(cancelled.lastFrame()).not.toContain('File search:');
        cancelled.unmount();
      }
    });

    it('forwards Ctrl+C to the interrupt handler', async () => {
      const interrupt = vi.fn();
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, complete: vi.fn() }}
          interrupt={interrupt}
        />,
      );

      view.stdin.write('\x03');
      await waitUntil(() => interrupt.mock.calls.length === 1);

      expect(interrupt).toHaveBeenCalledOnce();
      view.unmount();
    });

    it('ignores a stale search generation', async () => {
      const pending: Array<(generation: number) => void> = [];
      const search = vi.fn<WorkspacePathIndex['search']>(
        query =>
          new Promise(resolve => {
            pending.push(resultGeneration =>
              resolve({
                generation: resultGeneration,
                query,
                fileCount: 1,
                matches: [{ path: `${query}.ts`, score: 1, indices: [] }],
              }),
            );
          }),
      );
      const view = render(
        <WiredPromptEditor
          request={{ id: 1, label: 'you> ', acceptsSubmission: true, files: fileSearch(search), complete: vi.fn() }}
          interrupt={vi.fn()}
        />,
      );

      await write(view, '@a');
      await write(view, 'b');
      expect(pending.length).toBeGreaterThanOrEqual(2);
      pending.at(-1)!(search.mock.calls.length);
      await tick();
      pending[0]!(1);
      await tick();

      expect(view.lastFrame()).toContain('ab.ts');
      expect(view.lastFrame()).not.toContain('a.ts\n');
      view.unmount();
    });
  });
});

function fileSearch(search: WorkspacePathIndex['search']): WorkspacePathIndex {
  return {
    initialize: async () => ({
      root: '/project',
      fileCount: 0,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    }),
    search,
    glob: async () => ({ files: [], truncated: false }),
    searchContents: async () => ({
      outputMode: 'files_with_matches',
      files: [],
      searchedFiles: 0,
      skippedFiles: 0,
      indexTruncated: false,
      truncated: false,
      nextOffset: null,
    }),
    refresh: async () => ({
      root: '/project',
      fileCount: 0,
      fromCache: false,
      truncated: false,
      durationMilliseconds: 0,
    }),
    dispose: async () => {},
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Condition was not reached.');
}

async function tick(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function write(view: ReturnType<typeof render>, input: string): Promise<void> {
  view.stdin.write(input);
  await tick();
}

async function writeEscape(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write('\x1b');
  await new Promise<void>(resolve => setTimeout(resolve, 75));
}
