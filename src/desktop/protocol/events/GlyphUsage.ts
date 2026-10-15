export interface GlyphUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Saved turns with missing or incomplete provider reports, including older history. */
  readonly unreportedTurns?: number;
}
