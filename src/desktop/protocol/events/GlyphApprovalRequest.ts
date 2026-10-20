import type { GlyphModeSwap } from './GlyphModeSwap.ts';
export interface GlyphApprovalRequest {
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
