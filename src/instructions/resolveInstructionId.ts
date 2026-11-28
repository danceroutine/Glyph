/** Resolve a selection from a current catalog or an unambiguous older path-based ID. */
export function resolveInstructionId<T extends { readonly id: string; readonly legacyIds?: readonly string[] }>(
  sources: readonly T[],
  id: string,
): T | undefined {
  const exact = sources.find(source => source.id === id);
  if (exact) return exact;
  const matches = sources.filter(source => source.legacyIds?.includes(id));
  return matches.length === 1 ? matches[0] : undefined;
}
