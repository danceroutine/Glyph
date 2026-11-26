import { GlyphWorkbenchCommandType } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphRuntimeCommand } from '#src/desktop/host/GlyphDesktopWorkspaceRuntime.js';

export function isMutationCommand(command: GlyphRuntimeCommand): boolean {
  return ![
    GlyphWorkbenchCommandType.LIST_CHATS,
    GlyphWorkbenchCommandType.OPEN_CHAT,
    GlyphWorkbenchCommandType.REFRESH_CONTEXT_CATALOGS,
  ].includes(command.type);
}
