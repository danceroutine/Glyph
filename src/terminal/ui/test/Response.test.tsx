import { stripVTControlCharacters } from 'node:util';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import { DiagnosticSeverity } from '../../../chat/DiagnosticSeverity.ts';
import { ToolActivityPhase } from '../../../chat/ToolActivityPhase.ts';
import { Response } from '../Response.presentational.tsx';
import { WiredResponse } from '../Response.wired.tsx';
import { ToolActivity } from '../ToolActivity.presentational.tsx';

describe(Response, () => {
  describe('rendering', () => {
    it('renders every response section and a footer', () => {
      const view = render(
        <Response
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

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toBe(
        'assistant> answer\nthinking> thought\nfailed\n[tool< read completed]\nfooter',
      );
      view.unmount();
    });
  });
});

describe(WiredResponse, () => {
  describe('rendering', () => {
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

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toBe(
        'assistant> one two\nthinking> three four\nassistant> five',
      );
      view.unmount();
    });
  });
});

describe(ToolActivity, () => {
  afterEach(() => vi.restoreAllMocks());

  describe('rendering', () => {
    it('renders a started namespaced tool with multiline arguments', () => {
      const view = render(
        <ToolActivity
          activity={{
            phase: ToolActivityPhase.STARTED,
            namespace: 'project',
            name: 'read',
            callId: 'call',
            arguments: 'first\nsecond\u001b[31m',
          }}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe('[tool> project.read]\n  first\n  second');
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

      expect(view.lastFrame()).toBe('[tool> read]');
      view.unmount();
    });

    it.each([
      ['non-JSON output', 'plain', 'completed'],
      ['successful JSON output', '{}', 'completed'],
      ['a string error', '{"error":"failed"}', 'error: failed'],
      ['a null error', '{"error":null}', 'error: null'],
      ['an array error', '{"error":["one",2]}', 'error: one, 2'],
      ['an error code and message', '{"error":{"code":"BAD","message":"failed"}}', 'error: BAD: failed'],
      ['error context', '{"error":{"path":"src/App.tsx"}}', 'error: {"path":"src/App.tsx"} (path=src/App.tsx)'],
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

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toBe(`[tool< read ${expected}]`);
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

      expect(view.lastFrame()).toBe('[tool< read completed]');
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

      expect(view.lastFrame()).toBe('[tool< read error: undefined]');
      view.unmount();
    });
  });
});
