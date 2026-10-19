import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight(common);
highlighter.registerAlias({ javascript: ['jsx'], typescript: ['tsx'] });

/** Produces token nodes without HTML injection. Explicit unknown languages stay plain text. */
export function highlightGlyphCode(source: string, info: string | undefined, detectLanguage = false) {
  const language = info?.trim().split(/\s+/)[0]?.toLowerCase();
  try {
    if (language && highlighter.registered(language)) return highlighter.highlight(language, source).children;
    if (!language && detectLanguage)
      return highlighter.highlightAuto(source, {
        subset: ['typescript', 'javascript', 'json', 'python', 'bash', 'css', 'xml', 'sql'],
      }).children;
  } catch {
    // Incomplete code must remain editable and display verbatim when a grammar fails.
  }
  return undefined;
}
