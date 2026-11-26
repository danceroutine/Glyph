import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { WiredGlyphShellCommandCard } from '#code-oss/ui/GlyphShellCommandCard/GlyphShellCommandCard.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphShellCommandCard, () => {
  it('sends typed input to the running shell through the host', async () => {
    const writeShellInput = vi.fn(async () => {});
    render(
      <WiredGlyphShellCommandCard
        activity={{
          id: 'tool',
          name: 'shell',
          status: GlyphToolActivityStatus.STARTED,
          shell: {
            command: 'read answer',
            output: 'Continue?',
            sessionId: 'session',
            background: false,
            live: true,
            running: true,
          },
        }}
        chatId="chat"
        readOnly={false}
        actions={{ writeShellInput, stopShell: vi.fn(async () => {}) }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /read answer/u }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Input to shell' }), { target: { value: 'y' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send input' }));

    await waitFor(() => {
      expect(writeShellInput).toHaveBeenCalledWith('chat', 'session', 'y', true);
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Input to shell' }).value).toBe('');
    });
  });
});
