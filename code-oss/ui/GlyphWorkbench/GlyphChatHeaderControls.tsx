import { Clock, Ellipsis } from 'lucide-preact';
import { IconButton } from '#code-oss/ui/Button/Button.tsx';
import { Dropdown } from '#code-oss/ui/Dropdown/Dropdown.tsx';
import { useDropdownState } from '#code-oss/ui/Dropdown/useDropdownState.ts';
import { WiredGlyphChatHistory } from '#code-oss/ui/GlyphChatHistory/GlyphChatHistory.wired.tsx';
import type { GlyphWorkbenchStateOptions } from './useGlyphWorkbenchState.ts';
import { css } from '#code-oss/ui/design-system/index.ts';

const anchor = css({ position: 'relative', flexShrink: 0 });

export function GlyphRecentChats({ state, actions }: GlyphWorkbenchStateOptions) {
  const picker = useDropdownState<string>({ items: [], selectedIndex: -1, label: value => value, choose: () => {} });
  return (
    <div
      class={anchor}
      ref={picker.root}
      onKeyDown={event => {
        if (event.key === 'Escape' || !(event.target instanceof HTMLInputElement)) picker.keydown(event);
      }}
    >
      <IconButton
        buttonRef={picker.trigger}
        type="button"
        aria-label="Recent chats"
        title="Recent and archived chats"
        aria-expanded={picker.open}
        aria-haspopup="dialog"
        onClick={picker.toggle}
      >
        <Clock size={18} />
      </IconButton>
      {picker.open && (
        <Dropdown<string>
          id={picker.id}
          role="dialog"
          label="Recent chats"
          items={[]}
          itemKey={value => value}
          itemLabel={value => value}
          renderItem={value => value}
          activeIndex={-1}
          selectedIndex={-1}
          highlight={() => {}}
          choose={() => {}}
          width={340}
          topLayer
        >
          <WiredGlyphChatHistory
            state={state}
            compact
            actions={{
              ...actions,
              openChat: async id => {
                await actions.openChat(id);
                picker.toggle();
              },
            }}
          />
        </Dropdown>
      )}
    </div>
  );
}

export function GlyphChatMenu({ state, actions }: GlyphWorkbenchStateOptions) {
  const items = [
    ...(actions.chatMenuActions ?? []),
    {
      id: 'close-all',
      label: 'Close All Chat Tabs',
      run: async () => {
        for (const id of state.openChatIds ?? [state.selectedChatId ?? '']) await actions.closeChat?.(id);
      },
    },
  ];
  const menu = useDropdownState({
    items,
    selectedIndex: -1,
    label: item => item.label,
    choose: item => {
      void item.run();
    },
  });
  return (
    <div class={anchor} ref={menu.root} onKeyDown={menu.keydown}>
      <IconButton
        buttonRef={menu.trigger}
        type="button"
        aria-label="Chat actions"
        title="Chat actions"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
      >
        <Ellipsis size={18} />
      </IconButton>
      {menu.open && (
        <Dropdown
          id={menu.id}
          role="menu"
          label="Chat actions"
          items={items}
          itemKey={item => item.id}
          itemLabel={item => item.label}
          renderItem={item => item.label}
          activeIndex={menu.activeIndex}
          selectedIndex={-1}
          highlight={menu.highlight}
          choose={menu.select}
          width={250}
          topLayer
        />
      )}
    </div>
  );
}
