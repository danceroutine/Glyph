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
    if (parts.length > 0 && !path.endsWith('/')) branch.file = true;
  }
  const lines: string[] = [];
  const visit = (branch: Branch, depth: number) => {
    const children = [...branch.children].toSorted(
      ([left, a], [right, b]) => Number(a.file) - Number(b.file) || left.localeCompare(right, 'en'),
    );
    for (const [name, child] of children) {
      const label = /[\r\n\t]/u.test(name) ? JSON.stringify(name) : name;
      lines.push(`${'  '.repeat(depth)}${label}${child.file ? '' : '/'}`);
      visit(child, depth + 1);
    }
  };
  visit(root, 0);
  if (lines.length === 0) lines.push('(No search-visible files)');
  if (truncated) lines.push('… Tree truncated at the search limit.');
  return lines.join('\n');
}

/** Render the selected directory with its captured, policy-visible filenames. */
export function formatFolderAttachment(path: string, files: readonly string[], truncated: boolean): string {
  return `Directory tree: ${path}\n(Search-visible paths; file contents are not included.)\n\n${formatFolderContextOutline(files, truncated)}`;
}

/** Move only the directory heading of a captured outline to its current workspace route. */
export function rebindFolderAttachmentText(text: string, previousPath: string, path: string): string {
  const heading = 'Directory tree: ' + previousPath + '\n';
  return previousPath !== path && text.startsWith(heading)
    ? 'Directory tree: ' + path + '\n' + text.slice(heading.length)
    : text;
}
