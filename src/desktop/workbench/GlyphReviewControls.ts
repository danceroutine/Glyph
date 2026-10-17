export interface GlyphReviewControls {
  readonly label: string;
  readonly itemId?: string;
  readonly shortcutModifier?: string;
  readonly registerShortcuts?: (handler: (action: 'undo' | 'keep' | 'comment') => void) => () => void;
  readonly rejectWithComment?: (comment: string) => Promise<void>;
  readonly fileLabel?: string;
  readonly navigationDisabled?: boolean;
  readonly disabled: boolean;
  readonly keepDisabled: boolean;
  readonly keepAllDisabled?: boolean;
  readonly previous: () => void;
  readonly next: () => void;
  readonly previousFile?: () => Promise<void>;
  readonly nextFile?: () => Promise<void>;
  readonly keep: () => Promise<void>;
  readonly undo: () => Promise<void>;
  readonly keepFile?: () => Promise<void>;
  readonly undoFile?: () => Promise<void>;
  readonly keepAll?: () => Promise<void>;
}
export type GlyphReviewMount = (
  container: HTMLElement,
  controls: GlyphReviewControls,
) => {
  update(controls: GlyphReviewControls): void;
  dispose(): void;
};
