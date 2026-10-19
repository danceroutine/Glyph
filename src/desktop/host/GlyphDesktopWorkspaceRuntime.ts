import type { GlyphDesktopSnapshot } from '#src/desktop/protocol/events/GlyphDesktopSnapshot.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphWorkbenchCommand, GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';

export type GlyphRuntimeCommand = Exclude<
  GlyphWorkbenchCommand,
  {
    readonly type:
      | GlyphWorkbenchCommandType.ATTACH_WORKSPACE
      | GlyphWorkbenchCommandType.REQUEST_SNAPSHOT
      | GlyphWorkbenchCommandType.DETACH;
  }
>;

export type GlyphRuntimeSnapshot = Omit<GlyphDesktopSnapshot, 'ownerWindowId' | 'readOnly' | 'sequence'>;

/**
 * Workspace runtime port. The coordinator owns routing and authorization;
 * a runtime owns one workspace's domain state and long-running operations.
 */
export interface GlyphDesktopWorkspaceRuntime {
  snapshot(): Promise<GlyphRuntimeSnapshot>;
  handle(
    command: GlyphRuntimeCommand,
    context: {
      readonly windowId?: string;
      readonly signal: AbortSignal;
      readonly emit: (event: GlyphHostEvent) => void;
    },
  ): Promise<void>;
  connectionLost(windowId: string): Promise<void>;
  dispose(): Promise<void>;
}
