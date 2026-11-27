import type { SourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { pathToFileURL } from 'node:url';
import type { FilesystemNamePolicy } from '#src/workspace/FilesystemNamePolicy.js';
import { resolveAvailableIdentity } from '#src/shell/ShellRuntimePathPolicy.js';
import { dirname } from 'node:path';
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
  namePolicy: FilesystemNamePolicy,
  sourcePath?: string,
  configuredProfile?: string,
  sourceAliases?: SourcePathAliases,
  retainedAliases: readonly string[] = [],
): Promise<void> {
  const verifyProfile = () => {
    if (configuredProfile && sourcePath && resolveAvailableIdentity(configuredProfile) !== dirname(dirname(sourcePath)))
      throw new Error(
        'The configured user directory changed. Reopen the workspace before changing these instructions.',
      );
  };
  verifyProfile();
  const aliases = () =>
    sourcePath && sourceAliases
      ? [...new Set([...sourceAliases(sourcePath, kind === 'skill'), ...retainedAliases])]
      : undefined;
  const before = aliases();
  const sourceUris = before?.map(path => pathToFileURL(path).toString());
  const peers = editors.trustedUserEditors(owner, sourcePath, before);
  await Promise.all(
    [owner, ...peers.map(peer => peer.identity)].map(async identity => {
      const operationId = randomUUID();
      const result = await editors.request(identity, {
        type: GlyphEditorRequestType.CHECK_USER_WORKING_COPIES,
        operationId,
        kind,
        name,
        caseSensitive: namePolicy.caseSensitive,
        namePolicy,
        ...(sourceUris ? { sourceUris } : {}),
      });
      if (!result.ok || result.operationId !== operationId || result.workingCopiesClean !== true)
        throw new Error(
          result.error?.message ?? `Save or discard unsaved changes to the user ${kind} before changing it.`,
        );
    }),
  );
  verifyProfile();
  const after = aliases();
  const current = editors.trustedUserEditors(owner, sourcePath, after);
  if (
    JSON.stringify(after) !== JSON.stringify(before) ||
    current.length !== peers.length ||
    current.some(peer => !peers.some(previous => previous.connectionId === peer.connectionId))
  )
    throw new Error('Trusted editor windows changed during the working-copy check. Retry the change.');
}
