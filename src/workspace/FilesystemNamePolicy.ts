/** Filename comparisons supported by the probed filesystem. */
export interface FilesystemNamePolicy {
  readonly caseSensitive: boolean;
  readonly normalizesUnicode: boolean;
  readonly foldsUnicode: boolean;
}

export function normalizeVolumeName(
  value: string,
  policy?: { normalizesUnicode?: boolean; foldsUnicode?: boolean },
): string {
  if (!policy?.normalizesUnicode) return value;
  if (policy.foldsUnicode && /^\p{ASCII}*$/u.test(value)) return value.toLowerCase();
  const normalized = value.normalize('NFC');
  if (!policy.foldsUnicode) return normalized;
  // Map one scalar at a time so Greek sigma is independent of its word position.
  // Default Unicode folding preserves dotless i and expands sharp s and ligatures.
  return Array.from(normalized, char => (char === 'ı' ? char : char.toLowerCase().toUpperCase().toLowerCase()))
    .join('')
    .normalize('NFC');
}

/** Resolve each directory's filename semantics in input order, including prospective directories. */
export type ReadDirectoryNamePolicies = (directories: readonly string[]) => readonly FilesystemNamePolicy[];
