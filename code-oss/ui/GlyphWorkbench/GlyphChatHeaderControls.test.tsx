import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DropdownProps } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphChatMenu, GlyphRecentChats } from '#code-oss/ui/GlyphWorkbench/GlyphChatHeaderControls.tsx';

type DropdownStateOptions = Parameters<
  typeof import('#code-oss/ui/Dropdown/useDropdownState.ts').useDropdownState<string>
>[0];

const rendered = vi.hoisted(() => ({
  dropdowns: [] as DropdownProps<string>[],
  states: [] as DropdownStateOptions[],
}));

vi.mock('#code-oss/ui/Dropdown/Dropdown.tsx', async importOriginal => {
  const actual = await importOriginal<typeof import('#code-oss/ui/Dropdown/Dropdown.tsx')>();
  return {
    ...actual,
    Dropdown: (props: DropdownProps<string>) => {
      rendered.dropdowns.push(props);
      return <actual.Dropdown {...props} />;
    },
  };
});

vi.mock('#code-oss/ui/Dropdown/useDropdownState.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('#code-oss/ui/Dropdown/useDropdownState.ts')>();
  return {
    ...actual,
    useDropdownState: (options: DropdownStateOptions) => {
      rendered.states.push(options);
      return actual.useDropdownState(options);
    },
  };
});

afterEach(cleanup);

const workbench = (overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState => ({
  status: GlyphWorkbenchStatus.READY,
  transcript: [],
  usage: {},
  accounts: [],
  models: [],
  chats: [
    {
      id: 'chat',
      title: 'Refactor parser',
      accountProvider: 'openai',
      accountId: 'account',
      modelSlug: 'gpt-5',
      updatedAt: new Date().toISOString(),
      turnCount: 1,
    },
  ],
  runs: [],
  proposals: [],
  ownerWindowId: 'window',
  readOnly: false,
  sequence: 0,
  ...overrides,
});

const headerActions = (overrides: Partial<GlyphWorkbenchViewActions> = {}) =>
  ({
    openChat: vi.fn(async () => {}),
    newChat: vi.fn(),
    selectAccount: vi.fn(async () => {}),
    ...overrides,
  }) as unknown as GlyphWorkbenchViewActions;

describe(GlyphRecentChats, () => {
  it('opens recent chats and closes once a chat is opened', async () => {
    const actions = headerActions();
    render(<GlyphRecentChats state={workbench()} actions={actions} />);
    const trigger = screen.getByRole('button', { name: 'Recent chats' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Recent chats' })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refactor parser' }));
    });

    expect(actions.openChat).toHaveBeenCalledWith('chat');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recent chats' })).toBeNull());
  });

  it('closes on Escape, even from the search field', () => {
    render(<GlyphRecentChats state={workbench()} actions={headerActions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recent chats' }));

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search chats' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Recent chats' })).toBeNull();
  });

  it('leaves typing in the search field to the search', () => {
    render(<GlyphRecentChats state={workbench()} actions={headerActions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recent chats' }));

    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search chats' }), { key: 'Tab' });

    expect(screen.getByRole('dialog', { name: 'Recent chats' })).toBeTruthy();
  });

  it('handles keys pressed outside of the search field as picker navigation', () => {
    render(<GlyphRecentChats state={workbench()} actions={headerActions()} />);
    const trigger = screen.getByRole('button', { name: 'Recent chats' });
    fireEvent.click(trigger);

    fireEvent.keyDown(trigger, { key: 'Tab' });

    expect(screen.queryByRole('dialog', { name: 'Recent chats' })).toBeNull();
  });

  it('provides inert item handling around its custom history content', () => {
    rendered.dropdowns.length = 0;
    rendered.states.length = 0;
    render(<GlyphRecentChats state={workbench()} actions={headerActions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recent chats' }));

    const dropdown = rendered.dropdowns.findLast(props => props.label === 'Recent chats')!;
    const picker = rendered.states.find(options => options.items.length === 0)!;

    expect([dropdown.itemKey('x'), dropdown.itemLabel('x'), dropdown.renderItem('x')]).toEqual(['x', 'x', 'x']);
    expect(dropdown.highlight(0)).toBeUndefined();
    expect(dropdown.choose('x')).toBeUndefined();
    expect(picker.label('x')).toBe('x');
    expect(picker.choose('x')).toBeUndefined();
  });
});

describe(GlyphChatMenu, () => {
  it('runs host chat actions from its menu', () => {
    const run = vi.fn();
    render(
      <GlyphChatMenu
        state={workbench()}
        actions={headerActions({ chatMenuActions: [{ id: 'rename', label: 'Rename Chat', run }] })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Chat actions' });

    fireEvent.click(trigger);

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Rename Chat',
      'Close All Chat Tabs',
    ]);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Chat' }));

    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes every open chat tab in turn', async () => {
    const closeChat = vi.fn(async () => {});
    render(<GlyphChatMenu state={workbench({ openChatIds: ['a', 'b'] })} actions={headerActions({ closeChat })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close All Chat Tabs' }));

    await waitFor(() => expect(closeChat.mock.calls).toEqual([['a'], ['b']]));
  });

  it('closes the selected chat or the new chat draft when the window tracks no tabs', async () => {
    const closeChat = vi.fn(async () => {});
    render(<GlyphChatMenu state={workbench({ selectedChatId: 'chat' })} actions={headerActions({ closeChat })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close All Chat Tabs' }));
    await waitFor(() => expect(closeChat).toHaveBeenCalledWith('chat'));
    cleanup();

    render(<GlyphChatMenu state={workbench()} actions={headerActions({ closeChat })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close All Chat Tabs' }));

    await waitFor(() => expect(closeChat).toHaveBeenLastCalledWith(''));
  });

  it('does nothing when the host cannot close chats', async () => {
    render(<GlyphChatMenu state={workbench({ openChatIds: ['a'] })} actions={headerActions()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Close All Chat Tabs' }));
    });

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('finds actions by typing their first letter', async () => {
    const closeChat = vi.fn(async () => {});
    render(
      <GlyphChatMenu
        state={workbench({ openChatIds: ['a'] })}
        actions={headerActions({
          closeChat,
          chatMenuActions: [{ id: 'rename', label: 'Rename Chat', run: vi.fn() }],
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Chat actions' });

    fireEvent.keyDown(trigger, { key: 'c' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    await waitFor(() => expect(closeChat).toHaveBeenCalledWith('a'));
  });

  it('chooses actions from the keyboard', () => {
    const run = vi.fn();
    render(
      <GlyphChatMenu
        state={workbench()}
        actions={headerActions({ chatMenuActions: [{ id: 'rename', label: 'Rename Chat', run }] })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Chat actions' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(run).toHaveBeenCalledOnce();
  });
});
