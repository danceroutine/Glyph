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

export function reviewControlsFixture(): ComponentProps<typeof WiredGlyphReviewControls> {
  return {
    label: '1 of 2',
    fileLabel: '1 of 2 Files',
    disabled: false,
    keepDisabled: false,
    previous: () => {},
    next: () => {},
    previousFile: async () => {},
    nextFile: async () => {},
    keep: async () => {},
    undo: async () => {},
    keepFile: async () => {},
    undoFile: async () => {},
    keepAll: async () => {},
  };
}
