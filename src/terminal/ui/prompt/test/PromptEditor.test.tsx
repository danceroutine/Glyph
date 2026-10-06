import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { TerminalActionType } from '../../../TerminalActionType.ts';
import { PromptEditor } from '../PromptEditor.presentational.tsx';
import { PromptRecord } from '../PromptRecord.presentational.tsx';
import { formatPromptText } from '../formatPromptText.ts';

describe(PromptEditor, () => {
  describe('rendering', () => {
    it('renders attachments, highlighted matches, selection, and errors', () => {
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={0}
          text={'hello\u001b[31m @src/App.tsx'}
          cursor={5}
          attachments={['src/App.tsx']}
          matches={[
            { path: 'src/App.tsx', score: 10, indices: [4, 5, 6] },
            { path: 'src/api.ts', score: 5, indices: [] },
          ]}
          commandMatches={[]}
          selectedMatch={0}
          searchError={'bad\u001b[31m'}
        />,
      );

      expect(promptRailContent(view.lastFrame())).toBe(
        'you> hello @App.tsx\n  › src/App.tsx\n    src/api.ts\n  File search: bad',
      );
      view.unmount();
    });

    it('expands an attachment path while the cursor touches its mention', () => {
      const text = 'inspect @examples/todo-app/src/App.tsx next';
      const mentionEnd = text.indexOf(' next');
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={0}
          text={text}
          cursor={mentionEnd}
          attachments={['examples/todo-app/src/App.tsx']}
          matches={[]}
          commandMatches={[]}
          selectedMatch={0}
          searchError=""
        />,
      );

      expect(promptRailContent(view.lastFrame())).toBe('you> inspect @examples/todo-app/src/App.tsx next');
      view.unmount();
    });

    it('omits optional rows when the prompt has no attachments, matches, or error', () => {
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={0}
          text="hello"
          cursor={5}
          attachments={[]}
          matches={[]}
          commandMatches={[]}
          selectedMatch={0}
          searchError=""
        />,
      );

      expect(promptRailContent(view.lastFrame())).toBe('you> hello');
      view.unmount();
    });

    it('hard-wraps the editable line to match cursor coordinate calculations', () => {
      const text = `${'x'.repeat(90)} multiple f`;
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={0}
          text={text}
          cursor={text.length}
          attachments={[]}
          matches={[]}
          commandMatches={[]}
          selectedMatch={0}
          searchError=""
        />,
      );

      const lines = promptRailContent(view.lastFrame()).split('\n');
      expect(lines.at(-2)).toMatch(/ mu$/u);
      expect(lines.at(-1)).toBe('ltiple f');
      view.unmount();
    });

    it.each([
      [1, '1 pending change · /review to resume'],
      [3, '3 pending changes · /review to resume'],
    ])('shows %i deferred changes in the composer rail', (pendingChanges, expected) => {
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={pendingChanges}
          text=""
          cursor={0}
          attachments={[]}
          matches={[]}
          commandMatches={[]}
          selectedMatch={0}
          searchError=""
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '')).toContain(expected);
      view.unmount();
    });

    it('renders slash commands with descriptions and selection', () => {
      const view = render(
        <PromptEditor
          label="you> "
          pendingChanges={0}
          text="/tr"
          cursor={3}
          attachments={[]}
          matches={[]}
          commandMatches={[
            { value: '/trace', description: 'Show tracing', action: { type: TerminalActionType.TRACE } },
            {
              value: '/trace on',
              description: 'Enable tracing',
              action: { type: TerminalActionType.TRACE, enabled: true },
            },
          ]}
          selectedMatch={1}
          searchError=""
        />,
      );

      expect(promptRailContent(view.lastFrame())).toBe(
        'you> /tr\n    /trace  Show tracing\n  › /trace on  Enable tracing',
      );
      view.unmount();
    });
  });
});

function promptRailContent(frame: string | undefined): string {
  return stripVTControlCharacters(frame ?? '')
    .split('\n')
    .filter(line => !/^\s*─+\s*$/u.test(line))
    .map(line => (line.startsWith(' ') ? line.slice(1) : line))
    .join('\n')
    .trim();
}

describe(formatPromptText, () => {
  it('maps the cursor against collapsed attachment names', () => {
    const text = 'Compare @src/client/App.tsx with @src/server/App.tsx please';
    const presentation = formatPromptText(text, ['src/client/App.tsx', 'src/server/App.tsx'], text.length);

    expect(presentation.segments.map(segment => segment.value).join('')).toBe('Compare @App.tsx with @App.tsx please');
    expect(presentation.cursorPrefix).toBe('Compare @App.tsx with @App.tsx please');
    expect(presentation.cursorTouchesAttachment).toBe(false);
  });
});

describe(PromptRecord, () => {
  describe('rendering', () => {
    it('renders submitted prompts with attachments', () => {
      const view = render(
        <PromptRecord
          label="you> "
          draft={{ prompt: 'inspect @src/App.tsx and @src/api.ts', attachmentPaths: ['src/App.tsx', 'src/api.ts'] }}
        />,
      );

      const rendered = stripVTControlCharacters(view.lastFrame() ?? '');
      const messageLine = rendered.split('\n').find(line => line.includes('inspect'))!;
      expect(messageLine.search(/\S/u)).toBeGreaterThan(40);
      expect(messageLine).toContain('inspect @App.tsx and @api.ts');
      view.unmount();
    });

    it('omits the attachment row for an unattached prompt', () => {
      const view = render(<PromptRecord label="you> " draft={{ prompt: 'inspect', attachmentPaths: [] }} />);

      expect(view.lastFrame()).toContain('inspect');
      view.unmount();
    });
  });
});
