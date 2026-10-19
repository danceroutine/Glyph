import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Check } from 'lucide-preact';
import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  popup: css({
    position: 'absolute',
    zIndex: 30,
    boxSizing: 'border-box',
    color: tokens.dropdown.foreground,
    fontSize: tokens.font.size.body,
  }),
  panel: css({
    background: tokens.dropdown.background,
    border: tokens.dropdown.border,
    borderRadius: 8,
    boxShadow: '0 8px 24px #0003',
    overflow: 'hidden',
  }),
  heading: css({ padding: '7px 10px 4px', color: tokens.text.muted, fontSize: tokens.font.size.detail }),
  list: css({ overflowY: 'auto', overscrollBehavior: 'contain', padding: 4 }),
  status: css({ padding: '8px 6px', color: tokens.text.muted }),
  row: css({
    '&&': {
      width: '100%',
      minHeight: 28,
      gap: 8,
      padding: '4px 6px',
      border: 0,
      justifyContent: 'flex-start',
      textAlign: 'left',
      color: tokens.dropdown.foreground,
    },
    '&&[data-highlighted=true]': { background: tokens.list.hoverBackground },
    ':focus-visible': { outlineOffset: -1 },
    '& > svg': { color: tokens.text.muted },
  }),
  check: css({ marginLeft: 'auto' }),
  preview: css({
    display: 'none',
    position: 'absolute',
    left: 'calc(100% + 4px)',
    width: 280,
    boxSizing: 'border-box',
    pointerEvents: 'none',
    '@container (min-width: 660px)': { display: 'block' },
  }),
};

export interface DropdownProps<T> {
  readonly role?: 'listbox' | 'menu' | 'dialog';
  readonly children?: ComponentChildren;
  readonly id: string;
  readonly label: string;
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  readonly itemLabel: (item: T) => string;
  readonly renderItem: (item: T) => ComponentChildren;
  readonly activeIndex: number;
  readonly selectedIndex: number;
  readonly highlight: (index: number) => void;
  readonly choose: (item: T) => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly heading?: ComponentChildren;
  readonly emptyMessage?: string;
  readonly busyMessage?: string;
  readonly showCheck?: boolean;
  /** Informational content beside the active row, when the container has room. */
  readonly preview?: ComponentChildren;
  readonly width?: number;
  readonly inset?: number;
  readonly offset?: number;
  readonly constrainToAnchor?: boolean;
  /** Escape native pane clipping while retaining the same anchored primitive. */
  readonly topLayer?: boolean;
}

/** Anchored to its positioned parent. Focus remains on the trigger or editable input. */
export function Dropdown<T>({
  role = 'listbox',
  children,
  id,
  label,
  items,
  itemKey,
  itemLabel,
  renderItem,
  activeIndex,
  selectedIndex,
  highlight,
  choose,
  disabled = false,
  busy = false,
  heading,
  emptyMessage = 'No options available',
  busyMessage = 'Loading…',
  showCheck = false,
  preview,
  width = 280,
  inset = 0,
  offset = 6,
  constrainToAnchor = false,
  topLayer = false,
}: DropdownProps<T>) {
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previewNode = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ below: false, height: 336, left: inset, width, edge: 0 });
  const [previewTop, setPreviewTop] = useState(0);
  const positionPreview = () => {
    const row = list.current?.querySelector<HTMLElement>('[data-highlighted=true]');
    if (!row || !menu.current || !previewNode.current) return;
    const bounds = menu.current.getBoundingClientRect();
    setPreviewTop(
      Math.max(
        0,
        Math.min(row.getBoundingClientRect().top - bounds.top, bounds.height - previewNode.current.offsetHeight),
      ),
    );
  };
  useLayoutEffect(() => {
    const element = menu.current;
    const anchor = element?.parentElement;
    if (!element || !anchor) return;
    if (topLayer) element.showPopover();
    const measure = () => {
      const bounds = anchor.getBoundingClientRect();
      const availableBelow = window.innerHeight - bounds.bottom;
      const below = bounds.top < 100 && availableBelow > bounds.top;
      const actualWidth = Math.max(
        0,
        Math.min(width, window.innerWidth - 16, constrainToAnchor ? bounds.width - inset * 2 : Infinity),
      );
      const left =
        Math.max(8, Math.min(bounds.left + inset, window.innerWidth - actualWidth - 8)) - (topLayer ? 0 : bounds.left);
      const height = Math.max(0, Math.min(336, (below ? availableBelow : bounds.top) - offset - (heading ? 40 : 16)));
      const edge = below ? bounds.bottom + offset : window.innerHeight - bounds.top + offset;
      setLayout(previous =>
        previous.edge === edge &&
        previous.below === below &&
        previous.height === height &&
        previous.left === left &&
        previous.width === actualWidth
          ? previous
          : { below, height, left, width: actualWidth, edge },
      );
      positionPreview();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(anchor);
    window.addEventListener('resize', measure);
    // Scrolling an ancestor may change which side of the anchor has room.
    const scroll = (event: Event) => {
      if (!element.contains(event.target as Node)) measure();
    };
    document.addEventListener('scroll', scroll, true);
    return () => {
      if (topLayer) element.hidePopover();
      observer.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [width, inset, offset, constrainToAnchor, topLayer, !!heading]);
  useLayoutEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-highlighted=true]');
    const container = list.current;
    if (row && container) {
      const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      if (top < 0) container.scrollTop += top;
      else if (top + row.offsetHeight > container.clientHeight)
        container.scrollTop += top + row.offsetHeight - container.clientHeight;
    }
    positionPreview();
  }, [activeIndex, items, busy, layout.height, preview]);
  return (
    <div
      ref={menu}
      class={styles.popup}
      data-dropdown
      popover={topLayer ? 'manual' : undefined}
      style={{
        left: `${layout.left}px`,
        width: `${layout.width}px`,
        ...(topLayer
          ? {
              position: 'fixed',
              margin: 0,
              padding: 0,
              border: 0,
              background: 'transparent',
              overflow: 'visible',
              color: 'inherit',
              right: 'auto',
              ...(layout.below
                ? { top: `${layout.edge}px`, bottom: 'auto' }
                : { bottom: `${layout.edge}px`, top: 'auto' }),
            }
          : layout.below
            ? { top: `calc(100% + ${offset}px)` }
            : { bottom: `calc(100% + ${offset}px)` }),
      }}
    >
      <div class={styles.panel}>
        {heading && <div class={styles.heading}>{heading}</div>}
        <div
          ref={list}
          id={id}
          class={styles.list}
          style={{ maxHeight: `${layout.height}px` }}
          role={role}
          aria-label={label}
          aria-busy={busy}
          onScroll={positionPreview}
        >
          {children ??
            (busy || !items.length ? (
              <div class={styles.status} role="status">
                {busy ? busyMessage : emptyMessage}
              </div>
            ) : (
              items.map((item, index) => (
                <Button
                  key={itemKey(item)}
                  id={`${id}-${index}`}
                  appearance={ButtonAppearance.GHOST}
                  role={role === 'menu' ? 'menuitem' : 'option'}
                  tabIndex={-1}
                  aria-label={itemLabel(item)}
                  title={itemLabel(item)}
                  aria-selected={role === 'listbox' ? selectedIndex === index : undefined}
                  data-highlighted={activeIndex === index}
                  class={styles.row}
                  disabled={disabled}
                  onMouseDown={event => event.preventDefault()}
                  onMouseEnter={() => highlight(index)}
                  onClick={() => choose(item)}
                >
                  {renderItem(item)}
                  {showCheck && selectedIndex === index && <Check class={styles.check} size={16} aria-hidden="true" />}
                </Button>
              ))
            ))}
        </div>
      </div>
      {preview && (
        <div
          ref={previewNode}
          class={`${styles.panel} ${styles.preview}`}
          style={{ top: `${previewTop}px` }}
          aria-hidden="true"
        >
          {preview}
        </div>
      )}
    </div>
  );
}
