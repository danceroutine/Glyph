export enum GlyphResponseDeltaKind {
  TEXT = 'text',
  REASONING = 'reasoning',
  DIAGNOSTIC = 'diagnostic',
}

export interface GlyphResponseDelta {
  readonly kind: GlyphResponseDeltaKind;
  readonly value: string;
}
