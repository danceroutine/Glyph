export interface ProviderTraceEntry {
  sequence: number;
  timestamp: string;
  kind: string;
  round?: number;
  data: unknown;
}
