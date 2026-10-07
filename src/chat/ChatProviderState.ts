/** JSON-serializable, provider-owned conversation context. */
export interface ChatProviderState {
  readonly provider: string;
  readonly version: number;
  readonly data: unknown;
}
