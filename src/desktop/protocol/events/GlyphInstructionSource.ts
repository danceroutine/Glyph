export interface GlyphInstructionSource {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly path: string;
  readonly scope: string;
  readonly status: 'active' | 'error';
  readonly message?: string;
}
