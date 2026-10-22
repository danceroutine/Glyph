import type { ComponentChildren } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { Dropdown, type DropdownProps } from '#code-oss/ui/Dropdown/Dropdown.tsx';

afterEach(cleanup);

function Anchor({ top, children }: { readonly top: number; readonly children: ComponentChildren }) {
  return (
    <div
      data-testid="anchor"
      style={{ position: 'fixed', top: `${top}px`, left: '40px', width: '300px', height: '30px' }}
    >
      {children}
    </div>
  );
}

function fruitProps(overrides: Partial<DropdownProps<string>> = {}): DropdownProps<string> {
  return {
    id: 'fruit',
    label: 'Fruit',
    items: ['Apple', 'Banana', 'Cherry'],
    itemKey: item => item,
    itemLabel: item => item,
    renderItem: item => <span>{item}</span>,
    activeIndex: 0,
    selectedIndex: 1,
    highlight: vi.fn(),
    choose: vi.fn(),
    ...overrides,
  };
}

function stubResizeObserver() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
}

describe(Dropdown, () => {
  it('lists items as options above its anchor', () => {
    const props = fruitProps();
    render(
      <Anchor top={500}>
        <Dropdown {...props} />
      </Anchor>,
    );

    const list = screen.getByRole('listbox', { name: 'Fruit' });
    const options = screen.getAllByRole('option');
    expect(list.id).toBe('fruit');
    expect(list.getAttribute('aria-busy')).toBe('false');
    expect(options.map(option => option.getAttribute('aria-label'))).toEqual(['Apple', 'Banana', 'Cherry']);
    expect(options.map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(options[0]!.dataset.highlighted).toBe('true');
    expect(options[0]!.id).toBe('fruit-0');
    expect(options[1]!.querySelector('svg')).toBeNull();
    const popup = list.closest<HTMLElement>('[data-dropdown]')!;
    expect(popup.style.bottom).toBe('calc(100% + 6px)');
    expect(popup.hasAttribute('popover')).toBe(false);
    expect(popup.style.width).toBe(`${Math.min(280, innerWidth - 16)}px`);
  });

  it('highlights hovered options and chooses clicked ones without taking focus', () => {
    const props = fruitProps();
    render(
      <Anchor top={500}>
        <Dropdown {...props} />
      </Anchor>,
    );
    const banana = screen.getByRole('option', { name: 'Banana' });

    fireEvent.mouseEnter(banana);
    const press = fireEvent.mouseDown(banana);
    fireEvent.click(banana);

    expect(props.highlight).toHaveBeenCalledWith(1);
    expect(press).toBe(false);
    expect(props.choose).toHaveBeenCalledWith('Banana');
  });

  it('opens below an anchor near the top of the viewport', () => {
    render(
      <Anchor top={10}>
        <Dropdown {...fruitProps({ offset: 3 })} />
      </Anchor>,
    );

    const popup = screen.getByRole('listbox').closest<HTMLElement>('[data-dropdown]')!;
    expect(popup.style.top).toBe('calc(100% + 3px)');
  });

  it('presents items as menu items in a menu', () => {
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ role: 'menu' })} />
      </Anchor>,
    );

    expect(screen.getAllByRole('menuitem').every(item => !item.hasAttribute('aria-selected'))).toBe(true);
  });

  it('presents unselectable options in a dialog', () => {
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ role: 'dialog' })} />
      </Anchor>,
    );

    expect(screen.getByRole('dialog', { name: 'Fruit' })).toBeTruthy();
    expect(screen.getAllByRole('option').every(item => !item.hasAttribute('aria-selected'))).toBe(true);
  });

  it('marks the selected option with a check and disables options when requested', () => {
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ showCheck: true, disabled: true, heading: 'Pick a fruit' })} />
      </Anchor>,
    );

    expect(screen.getByText('Pick a fruit')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Banana' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('option', { name: 'Apple' }).querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('option').every(option => (option as HTMLButtonElement).disabled)).toBe(true);
  });

  it('reports loading and empty states', () => {
    const { rerender } = render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ busy: true })} />
      </Anchor>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(screen.getByRole('listbox').getAttribute('aria-busy')).toBe('true');

    rerender(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ items: [] })} />
      </Anchor>,
    );
    expect(screen.getByRole('status').textContent).toBe('No options available');

    rerender(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ items: [], emptyMessage: 'Nothing ripe' })} />
      </Anchor>,
    );
    expect(screen.getByRole('status').textContent).toBe('Nothing ripe');

    rerender(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ busy: true, busyMessage: 'Picking…' })} />
      </Anchor>,
    );
    expect(screen.getByRole('status').textContent).toBe('Picking…');
  });

  it('renders custom content instead of items', () => {
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps()}>
          <p>Custom body</p>
        </Dropdown>
      </Anchor>,
    );

    expect(screen.getByText('Custom body')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('fits within its anchor when constrained', () => {
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ constrainToAnchor: true, inset: 12, width: 400 })} />
      </Anchor>,
    );

    const popup = screen.getByRole('listbox').closest<HTMLElement>('[data-dropdown]')!;
    expect(popup.style.width).toBe(`${Math.min(276, innerWidth - 16)}px`);
  });

  it('keeps its default placement when it has no anchoring element', () => {
    const container = document.createDocumentFragment();

    render(<Dropdown {...fruitProps({ inset: 5, width: 200 })} />, { container: container as never });

    const popup = container.querySelector<HTMLElement>('[data-dropdown]')!;
    expect(popup.style.left).toBe('5px');
    expect(popup.style.width).toBe('200px');
  });

  it('escapes pane clipping in the top layer above its anchor', () => {
    const hide = vi.spyOn(HTMLElement.prototype, 'hidePopover');
    onTestFinished(() => {
      hide.mockRestore();
    });
    const { unmount } = render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ topLayer: true })} />
      </Anchor>,
    );

    const popup = screen.getByRole('listbox').closest<HTMLElement>('[data-dropdown]')!;
    expect(popup.getAttribute('popover')).toBe('manual');
    expect(popup.matches(':popover-open')).toBe(true);
    expect(popup.style.position).toBe('fixed');
    expect(popup.style.bottom).toBe(`${innerHeight - 500 + 6}px`);
    expect(popup.style.top).toBe('auto');
    unmount();

    expect(hide).toHaveBeenCalledOnce();
  });

  it('escapes pane clipping in the top layer below its anchor', () => {
    render(
      <Anchor top={10}>
        <Dropdown {...fruitProps({ topLayer: true })} />
      </Anchor>,
    );

    const popup = screen.getByRole('listbox').closest<HTMLElement>('[data-dropdown]')!;
    expect(popup.style.top).toBe(`${40 + 6}px`);
    expect(popup.style.bottom).toBe('auto');
  });

  it('repositions when the window resizes or an outer container scrolls', () => {
    stubResizeObserver();
    render(
      <Anchor top={500}>
        <Dropdown {...fruitProps()} />
      </Anchor>,
    );
    const popup = screen.getByRole('listbox').closest<HTMLElement>('[data-dropdown]')!;
    const anchor = screen.getByTestId('anchor');

    fireEvent(window, new Event('resize'));
    expect(popup.style.bottom).toBe('calc(100% + 6px)');
    anchor.style.top = '10px';
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(popup.style.bottom).toBe('calc(100% + 6px)');
    fireEvent.scroll(document.body);

    expect(popup.style.top).toBe('calc(100% + 6px)');
  });

  it('scrolls the highlighted option into view', () => {
    const items = Array.from({ length: 30 }, (_, index) => `Item ${index}`);
    const { rerender } = render(
      <Anchor top={122}>
        <Dropdown {...fruitProps({ items, activeIndex: 20 })} />
      </Anchor>,
    );
    const list = screen.getByRole('listbox');
    const visible = (name: string) => {
      const row = screen.getByRole('option', { name }).getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
    };
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(visible('Item 20')).toBe(true);

    rerender(
      <Anchor top={122}>
        <Dropdown {...fruitProps({ items, activeIndex: 0 })} />
      </Anchor>,
    );

    expect(visible('Item 0')).toBe(true);
  });

  it('aligns its preview with the highlighted option', () => {
    const items = Array.from({ length: 6 }, (_, index) => `Item ${index}`);
    const { rerender } = render(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ items, activeIndex: 3, preview: <p style={{ height: '20px' }}>Details</p> })} />
      </Anchor>,
    );
    const preview = screen.getByText('Details').parentElement!;
    const popup = preview.parentElement!;
    const row = screen.getByRole('option', { name: 'Item 3' });
    expect(preview.style.top).toBe(`${row.getBoundingClientRect().top - popup.getBoundingClientRect().top}px`);

    fireEvent.scroll(screen.getByRole('listbox'));
    rerender(
      <Anchor top={500}>
        <Dropdown {...fruitProps({ items, activeIndex: -1, preview: <p>Details</p> })} />
      </Anchor>,
    );

    expect(screen.getByText('Details')).toBeTruthy();
  });
});
