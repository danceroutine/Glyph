import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  GlyphWorkbench,
  type GlyphWorkbenchProps,
} from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';

afterEach(cleanup);

const workbenchProps = (overrides: Partial<GlyphWorkbenchProps> = {}): GlyphWorkbenchProps => ({
  root: createRef<HTMLDivElement>(),
  toggle: createRef<HTMLButtonElement>(),
  historyOpen: false,
  tabs: [
    { id: 'a', title: 'Alpha', selected: false },
    { id: 'b', title: 'Beta', selected: true },
    { id: 'c', title: 'Gamma', selected: false },
  ],
  selectTab: vi.fn(),
  closeTab: vi.fn(),
  newChatDisabled: false,
  navigationError: undefined,
  newChat: vi.fn(),
  toggleHistory: vi.fn(),
  closeHistory: vi.fn(),
  recentChats: <span>Recent chats</span>,
  menu: <span>Menu</span>,
  transcript: <section>Transcript</section>,
  usage: <span>Usage</span>,
  question: <form aria-label="Question">Question</form>,
  composer: <footer>Composer</footer>,
  history: <aside>History</aside>,
  ...overrides,
});

describe(GlyphWorkbench, () => {
  it('lays out the conversation header, content and history', () => {
    const props = workbenchProps();
    const { container } = render(<GlyphWorkbench {...props} />);

    const root = container.firstElementChild as HTMLElement;
    expect(props.root.current).toBe(root);
    expect(root.classList.contains('glyph-workbench')).toBe(true);
    expect(root.hasAttribute('data-history-open')).toBe(false);
    const main = screen.getByRole('main', { name: 'Current conversation' });
    expect([...main.children].slice(1).map(child => child.textContent)).toEqual([
      'Transcript',
      'Question',
      'Composer',
      'Usage',
    ]);
    expect(main.querySelector('header')?.textContent).toContain('Recent chats');
    expect(main.querySelector('header')?.textContent).toContain('Menu');
    expect(main.nextElementSibling?.textContent).toBe('History');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists open chats as tabs with only the selected one focusable', () => {
    render(<GlyphWorkbench {...workbenchProps()} />);

    const tabs = screen.getAllByRole('tab');
    expect(screen.getByRole('tablist', { name: 'Open chats' })).toBeTruthy();
    expect(tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected'), tab.tabIndex])).toEqual([
      ['Alpha', 'false', -1],
      ['Beta', 'true', 0],
      ['Gamma', 'false', -1],
    ]);
    expect(tabs[1]!.parentElement!.hasAttribute('data-selected')).toBe(true);
    expect(tabs[0]!.parentElement!.hasAttribute('data-selected')).toBe(false);
  });

  it('scrolls the selected tab into view', () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    onTestFinished(() => scrollIntoView.mockRestore());

    render(<GlyphWorkbench {...workbenchProps()} />);

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('tab', { name: 'Beta' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('selects and closes tabs', () => {
    const props = workbenchProps();
    render(<GlyphWorkbench {...props} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Gamma' }));

    expect(props.selectTab).toHaveBeenCalledWith('a');
    expect(props.closeTab).toHaveBeenCalledWith('c');
  });

  it('moves between tabs with the arrow, Home and End keys', () => {
    const props = workbenchProps();
    render(<GlyphWorkbench {...props} />);
    const tabs = screen.getAllByRole('tab');

    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    tabs[2]!.dispatchEvent(right);
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[1]!, { key: 'Home' });
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    fireEvent.keyDown(tabs[1]!, { key: 'a' });

    expect(right.defaultPrevented).toBe(true);
    expect((props.selectTab as ReturnType<typeof vi.fn>).mock.calls).toEqual([['a'], ['c'], ['a'], ['c']]);
    expect(document.activeElement).toBe(tabs[2]);
  });

  it('closes the focused tab with Delete', () => {
    const props = workbenchProps();
    render(<GlyphWorkbench {...props} />);

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'Delete' });

    expect(props.closeTab).toHaveBeenCalledWith('b');
  });

  it('only allows closing the new chat tab alongside other tabs', () => {
    render(<GlyphWorkbench {...workbenchProps({ tabs: [{ id: '', title: 'New chat', selected: true }] })} />);
    expect(screen.queryByRole('button', { name: 'Close New chat' })).toBeNull();
    cleanup();

    render(
      <GlyphWorkbench
        {...workbenchProps({
          tabs: [
            { id: '', title: 'New chat', selected: true },
            { id: 'a', title: 'Alpha', selected: false },
          ],
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Close New chat' })).toBeTruthy();
  });

  it('starts a new chat and opens history', () => {
    const props = workbenchProps();
    render(<GlyphWorkbench {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const history = screen.getByRole('button', { name: 'Chat history' });
    expect(props.toggle.current).toBe(history);
    expect(history.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(history);

    expect(props.newChat).toHaveBeenCalledOnce();
    expect(props.toggleHistory).toHaveBeenCalledOnce();
  });

  it('disables chat navigation while unavailable', () => {
    render(<GlyphWorkbench {...workbenchProps({ newChatDisabled: true })} />);

    for (const element of [
      ...screen.getAllByRole('tab'),
      screen.getByRole('button', { name: 'Close Alpha' }),
      screen.getByRole('button', { name: 'New chat' }),
    ])
      expect((element as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides recent chats and the history button while history is open and closes it on Escape', () => {
    const props = workbenchProps({ historyOpen: true });
    const { container } = render(<GlyphWorkbench {...props} />);

    expect((container.firstElementChild as HTMLElement).dataset.historyOpen).toBe('true');
    expect(screen.queryByText('Recent chats')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Chat history' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'New chat' }), { key: 'Enter' });
    expect(props.closeHistory).not.toHaveBeenCalled();

    const outer = vi.fn();
    container.addEventListener('keydown', outer);
    fireEvent.keyDown(screen.getByRole('button', { name: 'New chat' }), { key: 'Escape' });

    expect(props.closeHistory).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('ignores Escape while history is closed', () => {
    const props = workbenchProps();
    render(<GlyphWorkbench {...props} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'New chat' }), { key: 'Escape' });

    expect(props.closeHistory).not.toHaveBeenCalled();
  });

  it('shows workspace messages with an optional retry', () => {
    const retryWorkspace = vi.fn();
    render(<GlyphWorkbench {...workbenchProps({ workspaceMessage: 'Disconnected', retryWorkspace })} />);

    expect(screen.getByRole('status').textContent).toBe('DisconnectedRetry');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryWorkspace).toHaveBeenCalledOnce();
    cleanup();

    render(<GlyphWorkbench {...workbenchProps({ workspaceMessage: 'Opening workspace' })} />);
    expect(screen.getByRole('status').textContent).toBe('Opening workspace');
  });

  it('shows navigation errors', () => {
    render(<GlyphWorkbench {...workbenchProps({ navigationError: 'Chat not found' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Chat not found');
  });
});
