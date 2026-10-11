export interface GlyphApprovalRequest {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly sandboxed: boolean;
  readonly expiresAt?: string;
}
