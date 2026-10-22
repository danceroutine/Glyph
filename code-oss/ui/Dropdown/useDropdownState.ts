import { useEffect, useId, useRef, useState } from 'preact/hooks';

export function dropdownNavigationIndex(key: string, index: number, count: number, wrap = true): number | undefined {
  if (!count) return undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return undefined;
  const next = index + (key === 'ArrowDown' ? 1 : -1);
  return wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next));
}

/** Select-only combobox behavior; editable suggestions can use Dropdown directly. */
export function useDropdownState<T>({
  items,
  selectedIndex,
  label,
  choose,
  disabled = false,
}: {
  readonly items: readonly T[];
  readonly selectedIndex: number;
  readonly label: (item: T) => string;
  readonly choose: (item: T) => void;
  readonly disabled?: boolean;
}) {
  const [isOpen, setOpen] = useState(false);
  const [highlighted, highlight] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef({ text: '', time: 0 });
  const id = useId();
  const open = isOpen && !disabled;
  const activeIndex = items.length > 0 ? Math.max(0, Math.min(highlighted, items.length - 1)) : -1;
  const close = () => {
    setOpen(false);
    search.current.text = '';
  };
  const show = () => {
    if (disabled) return;
    highlight(Math.max(0, selectedIndex));
    setOpen(true);
    trigger.current?.focus();
  };
  const select = (item: T) => {
    if (disabled) return;
    choose(item);
    close();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  return {
    root,
    trigger,
    id,
    open,
    activeIndex,
    highlight,
    select,
    toggle: () => {
      if (open) close();
      else show();
    },
    blur: (target: EventTarget | null) => {
      if (!(target instanceof Node) || root.current?.contains(target) !== true) close();
    },
    keydown: (event: KeyboardEvent) => {
      if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const next = dropdownNavigationIndex(event.key, activeIndex, items.length);
      if (next !== undefined && (open || event.key.startsWith('Arrow'))) {
        event.preventDefault();
        if (open) highlight(next);
        else show();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (open) {
          event.preventDefault();
          const item = items[activeIndex];
          if (item !== undefined) select(item);
        }
      } else if (event.key === 'Escape' && open) {
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.current?.focus();
      } else if (event.key === 'Tab') close();
      else if (event.key.length === 1 && items.length > 0) {
        event.preventDefault();
        const now = Date.now();
        const text = (now - search.current.time < 600 ? search.current.text : '') + event.key.toLocaleLowerCase();
        search.current = { text, time: now };
        const prefix = Array.from(text).every(char => char === text[0]) ? text[0]! : text;
        const start = prefix.length === 1 ? activeIndex + 1 : activeIndex;
        const index = items
          .map((_, offset) => (start + offset + items.length) % items.length)
          .find(index => label(items[index]!).toLocaleLowerCase().startsWith(prefix));
        if (!open) show();
        if (index !== undefined) highlight(index);
      }
    },
  };
}
