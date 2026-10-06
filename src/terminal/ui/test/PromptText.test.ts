import { describe, expect, it } from 'vitest';
import { formatPromptText } from '../PromptText.ts';

describe(formatPromptText, () => {
  it('returns plain text without cursor metadata when no cursor is supplied', () => {
    expect(formatPromptText('plain prompt', [], undefined)).toStrictEqual({
      segments: [{ type: 'text', value: 'plain prompt' }],
      cursorPrefix: undefined,
      cursorTouchesAttachment: false,
    });
  });

  it('clamps cursors before and after a collapsed attachment', () => {
    const text = 'open @src/deep/App.tsx now';

    expect(formatPromptText(text, ['src/deep/App.tsx'], -10)).toMatchObject({
      cursorPrefix: '',
      cursorTouchesAttachment: false,
    });
    expect(formatPromptText(text, ['src/deep/App.tsx'], 10_000)).toMatchObject({
      cursorPrefix: 'open @App.tsx now',
      cursorTouchesAttachment: false,
    });
  });

  it('expands an attachment at every cursor boundary inside its source mention', () => {
    const text = '@src/App.tsx';

    expect(formatPromptText(text, ['src/App.tsx'], 0)).toMatchObject({
      cursorPrefix: '',
      cursorTouchesAttachment: true,
    });
    expect(formatPromptText(text, ['src/App.tsx'], text.length)).toMatchObject({
      cursorPrefix: text,
      cursorTouchesAttachment: true,
    });
  });

  it('ignores embedded and suffix-adjacent lookalikes', () => {
    const text = 'x@src/App.tsx @src/App.tsx-tail';

    expect(formatPromptText(text, ['src/App.tsx'])).toStrictEqual({
      segments: [{ type: 'text', value: text }],
      cursorPrefix: undefined,
      cursorTouchesAttachment: false,
    });
  });

  it('prefers the longest same-offset mention and supports Windows and empty paths', () => {
    expect(formatPromptText('@folder name', ['folder', 'folder name']).segments).toStrictEqual([
      { type: 'attachment', value: '@folder name', collapsed: true },
    ]);
    expect(formatPromptText('@C:\\src\\App.tsx', ['C:\\src\\App.tsx']).segments).toStrictEqual([
      { type: 'attachment', value: '@App.tsx', collapsed: true },
    ]);
    expect(formatPromptText('@', ['']).segments).toStrictEqual([{ type: 'attachment', value: '@', collapsed: true }]);
  });
});
