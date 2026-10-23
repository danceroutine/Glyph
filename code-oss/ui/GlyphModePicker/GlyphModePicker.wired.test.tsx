import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { WiredGlyphModePicker } from '#code-oss/ui/GlyphModePicker/GlyphModePicker.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphModePicker, () => {
  it('changes the conversation mode from its options', () => {
    const change = vi.fn();
    render(<WiredGlyphModePicker mode={AgentModeID.AGENT} change={change} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Conversation mode' }));
    fireEvent.click(screen.getByRole('option', { name: 'Plan' }));

    expect(change).toHaveBeenCalledWith(AgentModeID.PLAN);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
