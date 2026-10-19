import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
export interface GlyphModePickerOptions {
  readonly mode: AgentModeID;
  readonly change: (mode: AgentModeID) => void;
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
  const select = (value: AgentModeID) => {
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
    modes: AgentMode.all,
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
          else
            setHighlighted(value => {
              const modes = AgentMode.all;
              const current = modes.findIndex(mode => mode.id === value);
              const offset = event.key === 'ArrowDown' ? 1 : -1;
              return modes[(current + offset + modes.length) % modes.length]!.id;
            });
          break;
        case 'Home':
        case 'End':
          if (open) {
            event.preventDefault();
            setHighlighted((event.key === 'Home' ? AgentMode.all[0]! : AgentMode.all.at(-1)!).id);
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
