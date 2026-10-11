/** Exact editor text the user chose to attach to a future turn. */
export interface GlyphWorkbenchSelection {
  readonly uri: string;
  readonly path: string;
  readonly text: string;
  readonly version: number;
}
