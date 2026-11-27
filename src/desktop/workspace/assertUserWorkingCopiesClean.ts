import { randomUUID } from 'node:crypto';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from './EditorRpcRouter.ts';

/** All trusted windows share the same configured user store, including windows with unrelated workspace roots. */
export async function assertUserWorkingCopiesClean(
  editors: Pick<EditorRpcRouter, 'request' | 'trustedUserEditors'>,
  owner: GlyphConnectionIdentity,
  kind: 'rule' | 'skill',
  name: string,
  caseSensitive: boolean,
): Promise<void> {
  const peers = editors.trustedUserEditors(owner);
  await Promise.all(
    [owner, ...peers.map(peer => peer.identity)].map(async identity => {
      const operationId = randomUUID();
      const result = await editors.request(identity, {
        type: GlyphEditorRequestType.CHECK_USER_WORKING_COPIES,
        operationId,
        kind,
        name,
        caseSensitive,
      });
      if (!result.ok || result.operationId !== operationId || result.workingCopiesClean !== true)
        throw new Error(
          result.error?.message ?? `Save or discard unsaved changes to the user ${kind} before changing it.`,
        );
    }),
  );
  const current = editors.trustedUserEditors(owner);
  if (
    current.length !== peers.length ||
    current.some(peer => !peers.some(previous => previous.connectionId === peer.connectionId))
  )
    throw new Error('Trusted editor windows changed during the working-copy check. Retry the change.');
}
