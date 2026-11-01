import type { GlyphInstructionSource } from './GlyphInstructionSource.ts';

export interface GlyphTurnContext {
  readonly sources: readonly GlyphInstructionSource[];
  readonly activations: readonly {
    readonly sourceId: string;
    readonly reason: 'always' | 'attachment' | 'file_access' | 'manual' | 'model';
    readonly paths?: readonly string[];
  }[];
  readonly candidates: readonly { readonly id: string; readonly name: string; readonly description: string }[];
}
