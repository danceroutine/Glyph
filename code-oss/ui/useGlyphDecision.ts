import { useRef, useState } from 'preact/hooks';

/** One in-flight submission per mounted decision; failed requests remain editable. */
export function useGlyphDecision() {
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (operation: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
      // The authoritative run update removes the completed card.
    } catch (failure) {
      submitting.current = false;
      setPending(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return { pending, error, submit };
}
