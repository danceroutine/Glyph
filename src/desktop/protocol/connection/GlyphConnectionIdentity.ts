/** Identifies the authority assigned to one renderer connection by Electron main. */
export interface GlyphConnectionIdentity {
  readonly profileId: string;
  readonly windowId: string;
  readonly workspaceId: string;
}
