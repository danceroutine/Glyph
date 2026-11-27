import type { GlyphDesktopSnapshot } from '#src/desktop/protocol/events/GlyphDesktopSnapshot.js';
import type { GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import type { GlyphWorkbenchCommand, GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';

export type GlyphAttachedCommand = Exclude<
  GlyphWorkbenchCommand,
  {
    readonly type:
      | GlyphWorkbenchCommandType.ATTACH_WORKSPACE
      | GlyphWorkbenchCommandType.REQUEST_SNAPSHOT
      | GlyphWorkbenchCommandType.DETACH;
  }
>;

export type GlyphRuntimeCommand = Exclude<
  GlyphAttachedCommand,
  {
    readonly type: GlyphWorkbenchCommandType.RESOLVE_SKILL_REFERENCE | GlyphWorkbenchCommandType.RESOLVE_RULE_REFERENCE;
  }
>;

export type GlyphRuntimeSnapshot = Omit<GlyphDesktopSnapshot, 'ownerWindowId' | 'readOnly' | 'sequence'>;

/**
 * Workspace runtime port. The coordinator owns routing and authorization;
 * a runtime owns one workspace's domain state and long-running operations.
 */
export interface GlyphDesktopWorkspaceRuntime {
  snapshot(): Promise<GlyphRuntimeSnapshot>;
  resolveSkillReference?(id: string, manifestUri?: string): string | undefined;
  resolveRuleReference?(id: string): string | undefined;
  handle(
    command: GlyphRuntimeCommand,
    context: {
      readonly windowId?: string;
      /** Revoked by the host when this attachment loses authority. Pass it through to deferred effects. */
      readonly signal: AbortSignal;
      readonly emit: (event: GlyphHostEvent) => void;
    },
  ): Promise<void>;
  connectionLost(windowId: string): Promise<void>;
  dispose(): Promise<void>;
}
