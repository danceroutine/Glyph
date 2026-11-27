import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from './EditorRpcRouter.ts';

/** Checks unsaved editor state for a host-authorized physical package destination. No buffer contents leave the editor. */
export async function assertSkillPackageClean(
  editors: Pick<EditorRpcRouter, 'request' | 'trustedSkillEditors'>,
  identity: GlyphConnectionIdentity,
  scope: 'project',
  absolutePackageDirectory: string,
  logicalProjectDirectoryUri?: string,
  ownerIntersections: readonly string[] = [],
): Promise<void> {
  if (!isAbsolute(absolutePackageDirectory))
    throw new Error('Skill working-copy checks require an absolute package directory.');
  const { CHECK_SKILL_WORKING_COPIES } = GlyphEditorRequestType;
  const peers = editors.trustedSkillEditors(identity, absolutePackageDirectory);
  const physicalPackageUri = pathToFileURL(absolutePackageDirectory).toString();
  const operationId = randomUUID();
  const checks = [
    {
      identity,
      request: {
        operationId,
        type: CHECK_SKILL_WORKING_COPIES,
        scope,
        directoryUri: logicalProjectDirectoryUri ?? physicalPackageUri,
        physicalPackageUri,
      } as const,
    },
    ...ownerIntersections.map(directoryUri => ({
      identity,
      request: {
        type: CHECK_SKILL_WORKING_COPIES,
        operationId: randomUUID(),
        scope: 'project',
        peerWorkspaceIntersection: true,
        directoryUri,
        physicalPackageUri,
      } as const,
    })),
    ...peers.map(peer => ({
      identity: peer.identity,
      request: {
        operationId: randomUUID(),
        type: CHECK_SKILL_WORKING_COPIES,
        scope,
        peerWorkspaceIntersection: true,
        physicalPackageUri,
        directoryUri:
          peer.directoryUri ??
          (() => {
            throw new Error('The peer project destination is unavailable.');
          })(),
      } as const,
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
  const current = editors.trustedSkillEditors(identity, absolutePackageDirectory);
  const peerKey = (peer: (typeof peers)[number]) => JSON.stringify([peer.connectionId, peer.directoryUri]);
  const currentKeys = new Set(current.map(peer => peerKey(peer)));
  if (currentKeys.size !== peers.length || peers.some(peer => !currentKeys.has(peerKey(peer))))
    throw new Error('The trusted Glyph windows changed during the working-copy check. Preview the skill change again.');
}
