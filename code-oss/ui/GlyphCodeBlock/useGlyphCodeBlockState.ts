import { highlightGlyphCode } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxHighlighting.ts';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

export function useGlyphCodeBlockState(
  source: string,
  info: string | undefined,
  copyText: ((text: string) => Promise<void>) | undefined,
) {
  const language = info?.trim().split(/\s+/)[0]?.toLowerCase() || 'text';
  const nodes = useMemo(() => highlightGlyphCode(source, language), [source, language]);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    setCopied(false);
    setError(false);
    return () => {
      revision.current += 1;
    };
  }, [source]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return {
    source,
    language,
    nodes,
    wrap,
    copied,
    error,
    toggleWrap: () => setWrap(value => !value),
    copy: async () => {
      const current = revision.current;
      try {
        await (copyText ? copyText(source) : navigator.clipboard.writeText(source));
        if (revision.current !== current) return;
        setError(false);
        setCopied(true);
      } catch {
        if (revision.current !== current) return;
        setCopied(false);
        setError(true);
      }
    },
  };
}
export type GlyphCodeBlockState = ReturnType<typeof useGlyphCodeBlockState>;
