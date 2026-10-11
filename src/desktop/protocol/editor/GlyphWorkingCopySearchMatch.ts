export interface GlyphWorkingCopySearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly lineText: string;
  readonly matchedText: string;
}
