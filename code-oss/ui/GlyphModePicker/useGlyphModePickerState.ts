import { useEffect, useId, useRef, useState } from 'preact/hooks';
export interface GlyphModePickerOptions {
  readonly mode: 'agent' | 'plan';
  readonly change: (mode: 'agent' | 'plan') => void;
}
export function useGlyphModePickerState({ mode, change }: GlyphModePickerOptions) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(mode);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => setOpen(false);
  const show = () => {
    setHighlighted(mode);
    setOpen(true);
    trigger.current?.focus();
  };
  const select = (value: 'agent' | 'plan') => {
    change(value);
    close();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return {
    mode,
    open,
    highlighted,
    root,
    trigger,
    id,
    select,
    setHighlighted,
    toggle: () => (open ? close() : show()),
    blur: (target: EventTarget | null) => {
      if (!(target instanceof Node) || !root.current?.contains(target)) close();
    },
    keydown: (event: KeyboardEvent) => {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault();
          if (!open) show();
          else setHighlighted(value => (value === 'agent' ? 'plan' : 'agent'));
          break;
        case 'Home':
        case 'End':
          if (open) {
            event.preventDefault();
            setHighlighted(event.key === 'Home' ? 'agent' : 'plan');
          }
          break;
        case 'Enter':
        case ' ':
          if (open) {
            event.preventDefault();
            select(highlighted);
          }
          break;
        case 'Escape':
          if (open) {
            event.preventDefault();
            event.stopPropagation();
            close();
            trigger.current?.focus();
          }
          break;
        case 'Tab':
          close();
          break;
      }
    },
  };
}
export type GlyphModePickerState = ReturnType<typeof useGlyphModePickerState>;
