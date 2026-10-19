import type { GlyphModeSwap } from './GlyphModeSwap.ts';
export interface GlyphApprovalRequest {
  readonly modeSwap?: GlyphModeSwap;
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly sandboxed: boolean;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly canRemember?: boolean;
  readonly expiresAt?: string;
}
