import type { GlyphReviewCommand } from './GlyphReviewCommand.ts';
export interface GlyphReviewControls {
  readonly label: string;
  readonly itemId?: string;
  /** Current file has no remaining review items. */
  readonly fileComplete?: boolean;
  /** Labels resolved by the host from the current user keybindings. Unbound commands are omitted. */
  readonly shortcuts?: Partial<Record<GlyphReviewCommand, string>>;
  readonly registerCommands?: (handler: (command: GlyphReviewCommand) => void) => () => void;
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
