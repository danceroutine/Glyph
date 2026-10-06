import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { PromptEditor } from '../PromptEditor.presentational.tsx';
import { PromptRecord } from '../PromptRecord.presentational.tsx';

describe(PromptEditor, () => {
  describe('rendering', () => {
    it('renders attachments, highlighted matches, selection, and errors', () => {
      const view = render(
        <PromptEditor
          label="you> "
          text={'hello\u001b[31m'}
          attachments={['src/App.tsx']}
          matches={[
            { path: 'src/App.tsx', score: 10, indices: [4, 5, 6] },
            { path: 'src/api.ts', score: 5, indices: [] },
          ]}
          selectedMatch={0}
          searchError={'bad\u001b[31m'}
        />,
      );

      expect(stripVTControlCharacters(view.lastFrame() ?? '').trimStart()).toBe(
        'you> hello\n  attached: src/App.tsx\n  › src/App.tsx\n    src/api.ts\n  File search: bad',
      );
      view.unmount();
    });

    it('omits optional rows when the prompt has no attachments, matches, or error', () => {
      const view = render(
        <PromptEditor label="you> " text="hello" attachments={[]} matches={[]} selectedMatch={0} searchError="" />,
      );

      expect(view.lastFrame()?.trimStart()).toBe('you> hello');
      view.unmount();
    });
  });
});

describe(PromptRecord, () => {
  describe('rendering', () => {
    it('renders submitted prompts with attachments', () => {
      const view = render(
        <PromptRecord label="you> " draft={{ prompt: 'inspect', attachmentPaths: ['src/App.tsx', 'src/api.ts'] }} />,
      );

      expect(view.lastFrame()?.trimStart()).toBe('you> inspect\n  attached: src/App.tsx, src/api.ts');
      view.unmount();
    });

    it('omits the attachment row for an unattached prompt', () => {
      const view = render(<PromptRecord label="you> " draft={{ prompt: 'inspect', attachmentPaths: [] }} />);

      expect(view.lastFrame()?.trimStart()).toBe('you> inspect');
      view.unmount();
    });
  });
});
