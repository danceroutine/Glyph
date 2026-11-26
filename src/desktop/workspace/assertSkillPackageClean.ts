import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from './EditorRpcRouter.ts';

/** Checks unsaved editor state for a host-authorized physical package destination. No buffer contents leave the editor. */
export async function assertSkillPackageClean(
  editors: Pick<EditorRpcRouter, 'request' | 'trustedSkillEditors'>,
  identity: GlyphConnectionIdentity,
  scope: 'user' | 'project',
  absolutePackageDirectory: string,
  logicalProjectDirectoryUri?: string,
): Promise<void> {
  if (!isAbsolute(absolutePackageDirectory))
    throw new Error('Skill working-copy checks require an absolute package directory.');
  const { CHECK_SKILL_WORKING_COPIES, CHECK_USER_SKILL_WORKING_COPIES } = GlyphEditorRequestType;
  const peers =
    scope === 'user'
      ? editors.trustedSkillEditors(identity)
      : editors.trustedSkillEditors(identity, absolutePackageDirectory);
  const operationId = randomUUID();
  const checks = [
    {
      identity,
      request:
        scope === 'user'
          ? ({
              operationId,
              type: CHECK_USER_SKILL_WORKING_COPIES,
              packageName: basename(absolutePackageDirectory),
            } as const)
          : ({
              operationId,
              type: CHECK_SKILL_WORKING_COPIES,
              scope,
              directoryUri: logicalProjectDirectoryUri ?? pathToFileURL(absolutePackageDirectory).toString(),
            } as const),
    },
    ...peers.map(peer => ({
      identity: peer.identity,
      request:
        scope === 'project'
          ? ({
              operationId: randomUUID(),
              type: CHECK_SKILL_WORKING_COPIES,
              scope,
              peerWorkspaceIntersection: true,
              directoryUri:
                peer.directoryUri ??
                (() => {
                  throw new Error('The peer project destination is unavailable.');
                })(),
            } as const)
          : ({
              operationId: randomUUID(),
              type: CHECK_USER_SKILL_WORKING_COPIES,
              packageName: basename(absolutePackageDirectory),
            } as const),
    })),
  ];
  await Promise.all(
    checks.map(async ({ identity: recipient, request }) => {
      const response = await editors.request(recipient, request);
      if (response.operationId !== request.operationId || !response.ok || typeof response.packageClean !== 'boolean')
        throw new Error(response.error?.message ?? 'The editor could not verify the skill working copies.');
      if (!response.packageClean) throw new Error('Save or discard unsaved skill edits before managing the package.');
    }),
  );
  const current =
    scope === 'user'
      ? editors.trustedSkillEditors(identity)
      : editors.trustedSkillEditors(identity, absolutePackageDirectory);
  const peerKey = (peer: (typeof peers)[number]) => JSON.stringify([peer.connectionId, peer.directoryUri]);
  const currentKeys = new Set(current.map(peer => peerKey(peer)));
  if (currentKeys.size !== peers.length || peers.some(peer => !currentKeys.has(peerKey(peer))))
    throw new Error('The trusted Glyph windows changed during the working-copy check. Preview the skill change again.');
}
