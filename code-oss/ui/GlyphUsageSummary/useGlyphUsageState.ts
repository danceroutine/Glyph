import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';

export function useGlyphUsageState() {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = popup.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(innerWidth - box.width - 8, anchor.left)),
      top: Math.max(
        8,
        anchor.top > box.height + 16
          ? anchor.top - box.height - 8
          : Math.min(innerHeight - box.height - 8, anchor.bottom + 8),
      ),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (trigger.current?.contains(target) !== true && popup.current?.contains(target) !== true) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const close = () => {
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);
  return {
    id,
    trigger,
    popup,
    open,
    position,
    toggle: () => {
      setOpen(value => !value);
    },
  };
}
