/** Bound transcript previews while provider history retains the complete tool payload. */
export function toToolActivityPreview(value: string): string {
  return value.length > 16_000 ? `${value.slice(0, 16_000)}\n… (truncated)` : value;
}
