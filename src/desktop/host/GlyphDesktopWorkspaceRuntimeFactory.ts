import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphWorkspaceRoot } from '#src/desktop/protocol/connection/GlyphWorkspaceRoot.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphDesktopWorkspaceRuntime } from './GlyphDesktopWorkspaceRuntime.ts';

/** Creates one runtime per mutation-owning workspace rather than per renderer. */
export interface GlyphDesktopWorkspaceRuntimeFactory {
  create(input: {
    readonly identity: GlyphConnectionIdentity;
    readonly roots: readonly GlyphWorkspaceRoot[];
    readonly trusted: boolean;
    readonly emit: (event: GlyphHostEvent) => void;
  }): Promise<GlyphDesktopWorkspaceRuntime>;
}
