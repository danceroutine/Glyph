export interface GlyphAccountSummary {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly inferenceAccess: boolean;
}
