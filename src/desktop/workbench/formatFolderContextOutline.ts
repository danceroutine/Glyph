/** Render search-visible relative paths without reading any file contents. */
export function formatFolderContextOutline(paths: readonly string[], truncated = false): string {
  interface Branch {
    readonly children: Map<string, Branch>;
    file: boolean;
  }
  const root: Branch = { children: new Map(), file: false };
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    let branch = root;
    for (const part of parts) {
      let child = branch.children.get(part);
      if (!child) {
        child = { children: new Map(), file: false };
        branch.children.set(part, child);
      }
      branch = child;
    }
    if (parts.length && !path.endsWith('/')) branch.file = true;
  }
  const lines: string[] = [];
  const visit = (branch: Branch, depth: number) => {
    const children = [...branch.children].sort(
      ([left, a], [right, b]) => Number(a.file) - Number(b.file) || left.localeCompare(right, 'en'),
    );
    for (const [name, child] of children) {
      const label = /[\r\n\t]/.test(name) ? JSON.stringify(name) : name;
      lines.push(`${'  '.repeat(depth)}${label}${child.file ? '' : '/'}`);
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  if (!lines.length) lines.push('(No search-visible files)');
  if (truncated) lines.push('… Tree truncated at the search limit.');
  return lines.join('\n');
}
