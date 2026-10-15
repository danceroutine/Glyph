export interface GlyphApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly sandboxed: boolean;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly canRemember?: boolean;
  readonly expiresAt?: string;
}
