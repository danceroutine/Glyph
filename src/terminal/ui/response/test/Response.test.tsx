import { stripVTControlCharacters } from 'node:util';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatResponsePartType } from '../../../../chat/ChatResponsePartType.ts';
import { DiagnosticSeverity } from '../../../../chat/DiagnosticSeverity.ts';
import { ToolActivityPhase } from '../../../../chat/ToolActivityPhase.ts';
import { Response } from '../Response.presentational.tsx';
import { WiredResponse } from '../Response.wired.tsx';
import { ToolActivity } from '../ToolActivity.presentational.tsx';

describe(Response, () => {
  describe('rendering', () => {
    it('renders every response section and a footer', () => {
      const view = render(
        <Response
          messageWidth={64}
          sections={[
            { type: ChatResponsePartType.TEXT, value: 'answer' },
            { type: ChatResponsePartType.REASONING_SUMMARY, value: 'thought' },
            { type: ChatResponsePartType.DIAGNOSTIC, severity: DiagnosticSeverity.ERROR, message: 'failed' },
            {
              type: ChatResponsePartType.TOOL,
              activity: {
                phase: ToolActivityPhase.COMPLETED,
                name: 'read',
                callId: 'call',
                arguments: '{}',
                output: '{}',
              },
            },
          ]}
          footer={<Text>footer</Text>}
        />,
      );

      expect(readableLines(view.lastFrame())).toEqual(['answer', 'thinking> thought', 'failed', 'read  ✓', 'footer']);
      expect(view.lastFrame()).toContain('╭');
      view.unmount();
    });
  });
});

describe(WiredResponse, () => {
  describe('rendering', () => {
    it('shows a transient thinking indicator before the first response event', () => {
      const view = render(<WiredResponse parts={[]} />);

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toMatch(/^thinking> [●·] [●·] [●·]$/u);
      view.rerender(<WiredResponse parts={[{ type: ChatResponsePartType.TEXT, value: 'ready' }]} />);
      expect(readableLines(view.lastFrame())).toEqual(['ready']);
      view.unmount();
    });

    it('does not show the thinking indicator for a completed empty response', () => {
      const view = render(<WiredResponse parts={[]} footer={<Text>complete</Text>} />);

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toBe('complete');
      view.unmount();
    });

    it('combines only adjacent text and reasoning fragments', () => {
      const view = render(
        <WiredResponse
          parts={[
            { type: ChatResponsePartType.TEXT, value: 'one' },
            { type: ChatResponsePartType.TEXT, value: ' two' },
            { type: ChatResponsePartType.REASONING_SUMMARY, value: 'three' },
            { type: ChatResponsePartType.REASONING_SUMMARY, value: ' four' },
            { type: ChatResponsePartType.TEXT, value: 'five' },
          ]}
        />,
      );

      expect(readableLines(view.lastFrame())).toEqual(['one two', 'thinking> three four', 'five']);
      view.unmount();
    });

    it('collapses reasoning when the response is committed', () => {
      const parts = [
        { type: ChatResponsePartType.REASONING_SUMMARY, value: 'Planning' },
        { type: ChatResponsePartType.TEXT, value: 'Finished' },
      ] as const;
      const view = render(<WiredResponse parts={parts} />);

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toContain('thinking> Planning');
      view.rerender(<WiredResponse parts={parts} footer={<Text>complete</Text>} />);

      const committed = stripVTControlCharacters(view.lastFrame() ?? '');
      expect(committed).not.toContain('thinking>');
      expect(committed).toContain('Finished');
      view.unmount();
    });

    it('renders strong emphasis in muted reasoning summaries without markdown delimiters', () => {
      const view = render(
        <WiredResponse
          parts={[
            {
              type: ChatResponsePartType.REASONING_SUMMARY,
              value: '**Planning discontinuous text edits** with __care__',
            },
          ]}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toBe(
        'thinking> Planning discontinuous text edits with care',
      );
      view.unmount();
    });

    it('coalesces tool lifecycle events into one successful tag', () => {
      const view = render(
        <WiredResponse
          parts={[
            {
              type: ChatResponsePartType.TOOL,
              activity: {
                phase: ToolActivityPhase.STARTED,
                namespace: 'project',
                name: 'read',
                callId: 'call',
                arguments: 'secret input',
              },
            },
            {
              type: ChatResponsePartType.TOOL,
              activity: {
                phase: ToolActivityPhase.COMPLETED,
                namespace: 'project',
                name: 'read',
                callId: 'call',
                arguments: 'secret input',
                output: 'large successful result',
              },
            },
          ]}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trim()).toBe('project.read  ✓');
      view.unmount();
    });

    it('animates a running tool through the wired response state', () => {
      const view = render(
        <WiredResponse
          parts={[
            {
              type: ChatResponsePartType.TOOL,
              activity: {
                phase: ToolActivityPhase.STARTED,
                namespace: 'project',
                name: 'read',
                callId: 'running-call',
                arguments: '{}',
              },
            },
          ]}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trim()).toMatch(/^project\.read  .$/u);
      view.unmount();
    });
  });
});

describe(ToolActivity, () => {
  afterEach(() => vi.restoreAllMocks());

  describe('rendering', () => {
    it('renders a started namespaced tool as a spinner tag without its arguments', () => {
      const view = render(
        <ToolActivity
          frame={3}
          activity={{
            phase: ToolActivityPhase.STARTED,
            namespace: 'project',
            name: 'read',
            callId: 'call',
            arguments: 'first\nsecond\u001b[31m',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' project.read  ⠸');
      view.unmount();
    });

    it('omits empty started-tool arguments', () => {
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.STARTED,
            name: 'read',
            callId: 'call',
            arguments: '',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' read  ⠋');
      view.unmount();
    });

    it('falls back to the first spinner frame for an out-of-range animation frame', () => {
      const view = render(
        <ToolActivity
          frame={-1}
          activity={{
            phase: ToolActivityPhase.STARTED,
            name: 'read',
            callId: 'call',
            arguments: '',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' read  ⠋');
      view.unmount();
    });

    it.each([
      ['non-JSON output', 'plain', ' read  ✓'],
      ['successful JSON output', '{}', ' read  ✓'],
      ['a string error', '{"error":"failed"}', ' read  ×\n  Error: failed'],
      ['a null error', '{"error":null}', ' read  ×\n  Error: null'],
      ['an array error', '{"error":["one",2]}', ' read  ×\n  Error: one, 2'],
      ['an error code and message', '{"error":{"code":"BAD","message":"failed"}}', ' read  ×\n  Error: BAD: failed'],
      [
        'error context',
        '{"error":{"path":"src/App.tsx"}}',
        ' read  ×\n  Error: {"path":"src/App.tsx"} (path=src/App.tsx)',
      ],
    ])('renders %s', (_case, output, expected) => {
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.COMPLETED,
            name: 'read',
            callId: 'call',
            arguments: '',
            output,
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(expected);
      view.unmount();
    });

    it('reveals sanitized tool arguments when the call fails', () => {
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.COMPLETED,
            name: 'write',
            callId: 'call',
            arguments: 'first\nsecond\u001b[31m',
            output: '{"error":"failed"}',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' write  ×\n  first\n  second\n  Error: failed');
      view.unmount();
    });

    it('handles a completed tool without output', () => {
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.COMPLETED,
            name: 'read',
            callId: 'call',
            arguments: '',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' read  ✓');
      view.unmount();
    });

    it('falls back to string coercion when parsed error details cannot be serialized', () => {
      vi.spyOn(JSON, 'parse').mockReturnValue({ error: undefined });
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.COMPLETED,
            name: 'read',
            callId: 'call',
            arguments: '',
            output: '{}',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(' read  ×\n  Error: undefined');
      view.unmount();
    });

    it('survives circular parsed error details', () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;
      vi.spyOn(JSON, 'parse').mockReturnValue({ error: circular });
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.COMPLETED,
            name: 'read',
            callId: 'call',
            arguments: '',
            output: '{}',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(
        ' read  ×\n  Error: Unprintable error details (self=Unprintable error details)',
      );
      view.unmount();
    });
  });
});

function readableLines(frame: string | undefined): string[] {
  return stripVTControlCharacters(frame ?? '')
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^[╭╰].*[╮╯]$/u.test(line))
    .map(line => (line.startsWith('│') && line.endsWith('│') ? line.slice(1, -1).trim() : line));
}
