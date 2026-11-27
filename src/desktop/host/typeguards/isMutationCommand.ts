import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphAttachedCommand } from '#src/desktop/host/GlyphDesktopWorkspaceRuntime.js';

export function isMutationCommand(command: GlyphAttachedCommand): boolean {
  return ![
    GlyphWorkbenchCommandType.LIST_CHATS,
    GlyphWorkbenchCommandType.OPEN_CHAT,
    GlyphWorkbenchCommandType.REFRESH_CONTEXT_CATALOGS,
    GlyphWorkbenchCommandType.RESOLVE_SKILL_REFERENCE,
    GlyphWorkbenchCommandType.RESOLVE_RULE_REFERENCE,
  ].includes(command.type);
}
