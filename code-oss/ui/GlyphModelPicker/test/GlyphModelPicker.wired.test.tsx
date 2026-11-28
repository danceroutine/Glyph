import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphModelPicker, () => {
  it('selects models from the workbench catalog through the host', () => {
    const selectModel = vi.fn(async (_model: string) => {});
    render(
      <WiredGlyphModelPicker
        state={{
          status: GlyphWorkbenchStatus.READY,
          transcript: [],
          usage: {},
          accounts: [],
          models: [
            { slug: 'gpt-5', name: 'GPT-5' },
            { slug: 'o3', name: 'o3' },
          ],
          chats: [],
          runs: [],
          proposals: [],
          ownerWindowId: 'window',
          readOnly: false,
          sequence: 0,
          selectedModel: 'gpt-5',
        }}
        actions={{ selectModel } as unknown as GlyphWorkbenchViewActions}
      />,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    fireEvent.click(screen.getByRole('option', { name: 'o3' }));

    expect(selectModel).toHaveBeenCalledWith('o3');
  });
});
