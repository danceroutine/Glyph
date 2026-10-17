export class GlyphComposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlyphComposerError';
  }
}
