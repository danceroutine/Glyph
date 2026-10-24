import type { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphModeSwap } from './GlyphModeSwap.ts';
export interface GlyphApprovalRequest {
  readonly choices?: readonly {
    readonly id: GlyphApprovalDecision;
    readonly label: string;
    readonly description: string;
  }[];
  readonly modeSwap?: GlyphModeSwap;
  readonly goal?: { readonly objective: string };
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly sandboxed: boolean;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly canRemember?: boolean;
  readonly expiresAt?: string;
}
