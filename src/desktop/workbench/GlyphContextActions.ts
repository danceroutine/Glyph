import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import type { GlyphContextAttachment } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';

export enum GlyphContextCandidateKind {
  FILE = 'file',
  FOLDER = 'folder',
  RULE = 'rule',
  SKILL = 'skill',
}

export interface GlyphContextCandidate {
  readonly uri: string;
  readonly path: string;
  readonly detail?: string;
  readonly kind?: GlyphContextCandidateKind;
  readonly name?: string;
  readonly ancestry?: readonly string[];
  readonly ruleId?: string;
  readonly skillId?: string;
  readonly revision?: string;
}
export interface GlyphContextActions {
  onDidChangeInstructions?(listener: () => void): () => void;
  selectIdeContext?(): Promise<readonly GlyphContextAttachment[]>;
  selectFiles(): Promise<readonly GlyphContextAttachment[]>;
  searchFiles(query: string): Promise<readonly GlyphContextCandidate[]>;
  /** Finds enabled manual rules and skills for the composer's slash-command picker. */
  searchInstructions(query: string): Promise<readonly GlyphContextCandidate[]>;
  captureFile(uri: string): Promise<GlyphContextAttachment>;
  captureFolder?(uri: string): Promise<GlyphContextAttachment>;
  openAttachment(attachment: Pick<GlyphAttachmentPreview, 'path' | 'uri' | 'range'>): Promise<void>;
  refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment>;
  checkAttachment(attachment: GlyphContextAttachment): Promise<string | undefined>;
}
