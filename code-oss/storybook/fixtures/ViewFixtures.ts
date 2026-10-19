import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';
import { fn } from 'storybook/test';
import type { GlyphContextBadgeProps } from '#code-oss/ui/GlyphContextBadge/GlyphContextBadge.presentational.tsx';
import type { ComponentProps } from 'preact';
import type { WiredGlyphReviewControls } from '#code-oss/ui/GlyphReviewControls/GlyphReviewControls.wired.tsx';

/** Badge examples share the same labels in isolated and mixed-prompt stories. */
export const contextBadges = {
  file: { label: 'ProviderDesktopRuntime.ts', title: 'src/desktop/host/ProviderDesktopRuntime.ts' },
  selection: { label: 'Untitled-1 (11-14)', title: 'Untitled-1 (11-14)' },
  skill: { label: 'agent-driven-pr', title: 'agent-driven-pr', skill: true },
  document: { label: 'cursor-ide-tools.md', title: 'docs/cursor-ide-tools.md' },
} satisfies Record<string, GlyphContextBadgeProps>;

/** macOS defaults for presentation previews; native labels come from the keybinding service. */
export const reviewShortcutLabels = {
  [GlyphReviewCommand.ADD_TO_CHAT]: '⌘L',
  [GlyphReviewCommand.KEEP]: '⌘Y',
  [GlyphReviewCommand.UNDO]: '⌘N',
  [GlyphReviewCommand.COMMENT]: '⌘R',
  [GlyphReviewCommand.KEEP_FILE]: '⌘↵',
  [GlyphReviewCommand.UNDO_FILE]: '⌘⌥⌫',
  [GlyphReviewCommand.KEEP_ALL]: '⇧⌘↵',
  [GlyphReviewCommand.NEXT_FILE]: '⌘⌥→',
  [GlyphReviewCommand.PREVIOUS_FILE]: '⌘⌥←',
  [GlyphReviewCommand.NEXT_CHANGE]: '⌥↓',
  [GlyphReviewCommand.PREVIOUS_CHANGE]: '⌥↑',
} satisfies Record<GlyphReviewCommand, string>;

export function reviewControlsFixture(): ComponentProps<typeof WiredGlyphReviewControls> {
  return {
    label: '1 of 2',
    shortcuts: reviewShortcutLabels,
    fileLabel: '1 of 2 Files',
    disabled: false,
    keepDisabled: false,
    previous: fn().mockName('ViewFixtures.previous'),
    next: fn().mockName('ViewFixtures.next'),
    previousFile: fn<() => Promise<void>>().mockName('ViewFixtures.previousFile').mockResolvedValue(undefined),
    nextFile: fn<() => Promise<void>>().mockName('ViewFixtures.nextFile').mockResolvedValue(undefined),
    keep: fn<() => Promise<void>>().mockName('ViewFixtures.keep').mockResolvedValue(undefined),
    undo: fn<() => Promise<void>>().mockName('ViewFixtures.undo').mockResolvedValue(undefined),
    keepFile: fn<() => Promise<void>>().mockName('ViewFixtures.keepFile').mockResolvedValue(undefined),
    undoFile: fn<() => Promise<void>>().mockName('ViewFixtures.undoFile').mockResolvedValue(undefined),
    keepAll: fn<() => Promise<void>>().mockName('ViewFixtures.keepAll').mockResolvedValue(undefined),
  };
}
