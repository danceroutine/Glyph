export enum GlyphWorkingCopyPatternKind {
  REGULAR_EXPRESSION = 'regular_expression',
  LITERAL = 'literal',
}

export interface GlyphWorkingCopySearchOptions {
  readonly patternKind: GlyphWorkingCopyPatternKind;
  readonly caseSensitive: boolean;
  readonly multiline: boolean;
  readonly limit: number;
}
