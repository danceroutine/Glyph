import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

export const aGlyphContextAttachment = (overrides: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment => ({
  kind: GlyphContextAttachmentKind.FILE,
  uri: 'file:///repo/src/app.ts',
  path: 'src/app.ts',
  text: 'const a = 1;',
  contentRevision: 'revision',
  ...overrides,
});
