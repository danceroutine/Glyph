import { common, createLowlight } from 'lowlight';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

const highlighter = createLowlight(common);
highlighter.registerAlias({ javascript: ['jsx'], typescript: ['tsx'] });

export function useGlyphCodeBlockState(
  source: string,
  info: string | undefined,
  copyText: ((text: string) => Promise<void>) | undefined,
) {
  const language = info?.trim().split(/\s+/)[0]?.toLowerCase() || 'text';
  const nodes = useMemo(() => {
    if (!highlighter.registered(language)) return undefined;
    try {
      return highlighter.highlight(language, source).children;
    } catch {
      // Incomplete streaming fences and unsupported syntax still display verbatim.
      return undefined;
    }
  }, [source, language]);
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
