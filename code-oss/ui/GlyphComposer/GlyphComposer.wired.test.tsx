import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphComposer } from '#code-oss/ui/GlyphComposer/GlyphComposer.wired.tsx';
import { GlyphComposerError } from '#code-oss/ui/GlyphComposer/GlyphComposerError.ts';

afterEach(cleanup);

function composerActions(overrides: Partial<GlyphWorkbenchViewActions> = {}): GlyphWorkbenchViewActions {
  return {
    composer: new GlyphComposerState(),
    context: {
      selectFiles: vi.fn(async () => []),
      searchFiles: vi.fn(async () => []),
      searchRules: vi.fn(async () => []),
      captureFile: vi.fn(),
      openAttachment: vi.fn(async () => {}),
      refreshAttachment: vi.fn(),
      checkAttachment: vi.fn(async () => undefined),
    },
    send: vi.fn(async () => {}),
    cancel: vi.fn(),
    ...overrides,
  } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;
}

describe(WiredGlyphComposer, () => {
  it('surrounds the prompt with its drawers and controls', () => {
    render(
      <WiredGlyphComposer
        status={GlyphWorkbenchStatus.READY}
        actions={composerActions()}
        modelControl={<span>Model control</span>}
        todos={<span>Todos</span>}
        reviews={<span>Reviews</span>}
        terminals={<span>Terminals</span>}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Message Glyph' })).toBeTruthy();
    for (const text of ['Model control', 'Todos', 'Reviews', 'Terminals']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByRole('combobox', { name: 'Conversation mode' }).textContent).toContain('Agent');
  });

  it('switches the conversation mode from the mode picker', async () => {
    const selectMode = vi.fn(async () => {});
    render(<WiredGlyphComposer status={GlyphWorkbenchStatus.READY} actions={composerActions({ selectMode })} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Conversation mode' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Plan' }));
    });

    expect(selectMode).toHaveBeenCalledWith(AgentModeID.PLAN);
  });
});

describe(GlyphComposerError, () => {
  it('names composer failures', () => {
    const error = new GlyphComposerError('Folder context is unavailable.');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GlyphComposerError');
    expect(error.message).toBe('Folder context is unavailable.');
  });
});
