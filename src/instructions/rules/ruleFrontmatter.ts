/** Split at complete delimiter lines, retaining the original text for revision-guarded edits. */
export function ruleFrontmatter(text: string) {
  const opening = /^---(\r?\n)/u.exec(text);
  if (!opening) return undefined;
  const start = opening[0].length;
  const closing = /^---(?:\r?\n|$)/mu.exec(text.slice(start));
  if (!closing) throw new Error('Rule frontmatter is missing its closing --- delimiter.');
  const end = start + closing.index;
  return {
    eol: opening[1]!,
    metadata: text.slice(start, end),
    closing: text.slice(end),
    body: text.slice(end + closing[0].length),
  };
}

export function withRuleEnabled(text: string, enabled: boolean): string {
  const frontmatter = ruleFrontmatter(text);
  const line = `enabled: ${enabled}`;
  if (!frontmatter) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return ['---', line, '---', text].join(eol);
  }
  const { eol, metadata, closing } = frontmatter;
  const next = /^enabled:/mu.test(metadata)
    ? metadata.replace(/^enabled:[^\r\n]*/mu, line)
    : `${metadata}${line}${eol}`;
  return `---${eol}${next}${closing}`;
}
