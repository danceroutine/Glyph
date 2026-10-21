import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dropdownNavigationIndex, useDropdownState } from '#code-oss/ui/Dropdown/useDropdownState.ts';

afterEach(cleanup);

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });

describe(dropdownNavigationIndex, () => {
  it('has no destination without items', () => {
    expect(dropdownNavigationIndex('ArrowDown', 0, 0)).toBeUndefined();
  });

  it('jumps to the first and last items', () => {
    expect(dropdownNavigationIndex('Home', 2, 5)).toBe(0);
    expect(dropdownNavigationIndex('End', 2, 5)).toBe(4);
  });

  it('ignores keys that do not navigate', () => {
    expect(dropdownNavigationIndex('Enter', 2, 5)).toBeUndefined();
  });

  it('wraps around both ends by default', () => {
    expect(dropdownNavigationIndex('ArrowDown', 4, 5)).toBe(0);
    expect(dropdownNavigationIndex('ArrowUp', 0, 5)).toBe(4);
  });

  it('stops at both ends when wrapping is disabled', () => {
    expect(dropdownNavigationIndex('ArrowDown', 4, 5, false)).toBe(4);
    expect(dropdownNavigationIndex('ArrowUp', 0, 5, false)).toBe(0);
    expect(dropdownNavigationIndex('ArrowDown', 1, 5, false)).toBe(2);
  });
});

describe(useDropdownState, () => {
  it('starts closed with the first item active', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta'], selectedIndex: 1, label: item => item, choose: vi.fn() },
    });

    expect(result.current.open).toBe(false);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.id).toBeTruthy();
  });

  it('has no active item when empty', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: [], selectedIndex: -1, label: item => item, choose: vi.fn() },
    });

    expect(result.current.activeIndex).toBe(-1);
  });

  it('opens on the selected item and focuses the trigger', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta', 'Gamma'], selectedIndex: 2, label: item => item, choose: vi.fn() },
    });
    const trigger = document.createElement('button');
    document.body.append(trigger);
    onTestFinished(() => trigger.remove());
    result.current.trigger.current = trigger;

    act(() => result.current.toggle());

    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(2);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes when toggled while open', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });

    act(() => result.current.toggle());
    act(() => result.current.toggle());

    expect(result.current.open).toBe(false);
  });

  it('chooses an item and closes', () => {
    const choose = vi.fn();
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta'], selectedIndex: 0, label: item => item, choose },
    });
    act(() => result.current.toggle());

    act(() => result.current.select('Beta'));

    expect(choose).toHaveBeenCalledWith('Beta');
    expect(result.current.open).toBe(false);
  });

  it('neither opens nor chooses while disabled', () => {
    const choose = vi.fn();
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose, disabled: true },
    });

    act(() => result.current.toggle());
    act(() => result.current.select('Alpha'));
    const event = key({ key: 'ArrowDown' });
    act(() => result.current.keydown(event));

    expect(result.current.open).toBe(false);
    expect(choose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes once it becomes disabled', () => {
    const props = {
      items: ['Alpha'],
      selectedIndex: 0,
      label: (item: string) => item,
      choose: vi.fn(),
      disabled: false,
    };
    const { result, rerender } = renderHook(useDropdownState<string>, { initialProps: props });
    act(() => result.current.toggle());

    rerender({ ...props, disabled: true });
    rerender({ ...props, disabled: false });

    expect(result.current.open).toBe(false);
  });

  it('closes when the pointer goes down outside of it', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });
    const root = document.createElement('div');
    const inside = root.appendChild(document.createElement('span'));
    document.body.append(root);
    onTestFinished(() => root.remove());
    result.current.root.current = root;
    act(() => result.current.toggle());

    act(() => {
      inside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(result.current.open).toBe(true);
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });

    expect(result.current.open).toBe(false);
  });

  it('closes when focus leaves the dropdown', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });
    const root = document.createElement('div');
    const inside = root.appendChild(document.createElement('button'));
    document.body.append(root);
    onTestFinished(() => root.remove());
    result.current.root.current = root;
    act(() => result.current.toggle());

    act(() => result.current.blur(inside));
    expect(result.current.open).toBe(true);
    act(() => result.current.blur(document.body));
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    act(() => result.current.blur(null));
    expect(result.current.open).toBe(false);
  });

  it('ignores keys pressed with modifiers or during composition', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });

    for (const init of [{ isComposing: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      act(() => result.current.keydown(key({ key: 'ArrowDown', ...init })));
    }

    expect(result.current.open).toBe(false);
  });

  it('opens with arrow keys and moves the highlight while open', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta', 'Gamma'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });

    const open = key({ key: 'ArrowDown' });
    act(() => result.current.keydown(open));
    expect(open.defaultPrevented).toBe(true);
    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(0);

    act(() => result.current.keydown(key({ key: 'ArrowDown' })));
    expect(result.current.activeIndex).toBe(1);
    act(() => result.current.keydown(key({ key: 'End' })));
    expect(result.current.activeIndex).toBe(2);
  });

  it('does not open from Home or End while closed', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });

    const home = key({ key: 'Home' });
    act(() => result.current.keydown(home));

    expect(result.current.open).toBe(false);
    expect(home.defaultPrevented).toBe(false);
  });

  it('chooses the active item with Enter or Space only while open', () => {
    const choose = vi.fn();
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha', 'Beta'], selectedIndex: 1, label: item => item, choose },
    });

    const closedEnter = key({ key: 'Enter' });
    act(() => result.current.keydown(closedEnter));
    expect(closedEnter.defaultPrevented).toBe(false);
    act(() => result.current.toggle());
    act(() => result.current.keydown(key({ key: ' ' })));

    expect(choose).toHaveBeenCalledWith('Beta');
    expect(result.current.open).toBe(false);
  });

  it('chooses nothing when confirming an empty list', () => {
    const choose = vi.fn();
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: [], selectedIndex: -1, label: item => item, choose },
    });
    act(() => result.current.toggle());

    const enter = key({ key: 'Enter' });
    act(() => result.current.keydown(enter));

    expect(enter.defaultPrevented).toBe(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });
    const trigger = document.createElement('button');
    document.body.append(trigger);
    onTestFinished(() => trigger.remove());
    result.current.trigger.current = trigger;
    act(() => result.current.toggle());
    trigger.blur();

    const escape = key({ key: 'Escape' });
    act(() => result.current.keydown(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(result.current.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('lets Escape through while closed', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });

    const escape = key({ key: 'Escape' });
    act(() => result.current.keydown(escape));

    expect(escape.defaultPrevented).toBe(false);
  });

  it('closes when Tab moves focus away', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Alpha'], selectedIndex: 0, label: item => item, choose: vi.fn() },
    });
    act(() => result.current.toggle());

    act(() => result.current.keydown(key({ key: 'Tab' })));

    expect(result.current.open).toBe(false);
  });

  it('ignores typing when there is nothing to find', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: [], selectedIndex: -1, label: item => item, choose: vi.fn() },
    });

    const typed = key({ key: 'a' });
    act(() => result.current.keydown(typed));

    expect(typed.defaultPrevented).toBe(false);
    expect(result.current.open).toBe(false);
  });

  it('opens and finds items by typing the start of their labels', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: {
        items: ['Apple', 'Banana', 'Blueberry', 'Cherry'],
        selectedIndex: 0,
        label: item => item,
        choose: vi.fn(),
      },
    });

    act(() => result.current.keydown(key({ key: 'B' })));
    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(1);

    act(() => result.current.keydown(key({ key: 'l' })));
    expect(result.current.activeIndex).toBe(2);
  });

  it('cycles through items sharing a repeated first letter', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: {
        items: ['Apple', 'Banana', 'Blueberry', 'Cherry'],
        selectedIndex: 0,
        label: item => item,
        choose: vi.fn(),
      },
    });

    act(() => result.current.keydown(key({ key: 'b' })));
    act(() => result.current.keydown(key({ key: 'b' })));

    expect(result.current.activeIndex).toBe(2);
  });

  it('starts a new search after a pause in typing', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: {
        items: ['Apple', 'Banana', 'Cherry'],
        selectedIndex: 0,
        label: item => item,
        choose: vi.fn(),
      },
    });

    act(() => result.current.keydown(key({ key: 'b' })));
    now.mockReturnValue(5000);
    act(() => result.current.keydown(key({ key: 'c' })));

    expect(result.current.activeIndex).toBe(2);
  });

  it('keeps the highlight when nothing matches the typed text', () => {
    const { result } = renderHook(useDropdownState<string>, {
      initialProps: { items: ['Apple', 'Banana'], selectedIndex: 1, label: item => item, choose: vi.fn() },
    });
    act(() => result.current.toggle());

    act(() => result.current.keydown(key({ key: 'z' })));

    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(1);
  });
});
