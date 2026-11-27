import type { FilesystemNamePolicy } from '#src/workspace/FilesystemNamePolicy.js';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from './EditorRpcRouter.ts';

type OwnerIntersections = readonly (string | { directoryUri: string; physicalPackageUri: string })[];

/**
 * Verifies one lifecycle decision against dirty editor buffers across physically intersecting workspace routes.
 * The host supplies the destination and any pre-swap aliases. Live owner routes and peer membership are checked again
 * after editor replies. Publication must repeat this check when it reaches another guarded mutation boundary.
 */
export async function assertSkillPackageClean(
  editors: Pick<EditorRpcRouter, 'request' | 'trustedSkillEditors'>,
  identity: GlyphConnectionIdentity,
  scope: 'project',
  absolutePackageDirectory: string,
  logicalProjectDirectoryUri?: string,
  ownerIntersections: OwnerIntersections | (() => OwnerIntersections) = [],
  namePolicy?: FilesystemNamePolicy,
  retainedAliases?: readonly string[],
): Promise<void> {
  if (!isAbsolute(absolutePackageDirectory))
    throw new Error('Skill working-copy checks require an absolute package directory.');
  const { CHECK_SKILL_WORKING_COPIES } = GlyphEditorRequestType;
  const peers = editors.trustedSkillEditors(identity, absolutePackageDirectory, retainedAliases);
  const physicalPackageUri = pathToFileURL(absolutePackageDirectory).toString();
  const ownerRoutes = typeof ownerIntersections === 'function' ? ownerIntersections() : ownerIntersections;
  const operationId = randomUUID();
  const comparison = namePolicy ? { namePolicy } : {};
  const checks = [
    {
      identity,
      request: {
        operationId,
        type: CHECK_SKILL_WORKING_COPIES,
        scope,
        directoryUri: logicalProjectDirectoryUri ?? physicalPackageUri,
        physicalPackageUri,
        ...comparison,
      } as const,
    },
    ...[
      ...new Map(ownerRoutes.map(value => [typeof value === 'string' ? value : value.directoryUri, value])).values(),
    ].map(value => ({
      identity,
      request: {
        type: CHECK_SKILL_WORKING_COPIES,
        operationId: randomUUID(),
        scope: 'project',
        peerWorkspaceIntersection: true,
        directoryUri: typeof value === 'string' ? value : value.directoryUri,
        physicalPackageUri: typeof value === 'string' ? physicalPackageUri : value.physicalPackageUri,
        ...comparison,
      } as const,
    })),
    ...peers.map(peer => ({
      identity: peer.identity,
      request: {
        operationId: randomUUID(),
        type: CHECK_SKILL_WORKING_COPIES,
        scope,
        peerWorkspaceIntersection: true,
        physicalPackageUri: peer.physicalPackageUri ?? physicalPackageUri,
        ...comparison,
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
  if (typeof ownerIntersections === 'function' && JSON.stringify(ownerIntersections()) !== JSON.stringify(ownerRoutes))
    throw new Error('Project editor routes changed during the working-copy check. Retry the change.');
  const current = editors.trustedSkillEditors(identity, absolutePackageDirectory, retainedAliases);
  const peerKey = (peer: (typeof peers)[number]) =>
    JSON.stringify([peer.connectionId, peer.directoryUri, peer.physicalPackageUri]);
  const currentKeys = new Set(current.map(peer => peerKey(peer)));
  if (currentKeys.size !== peers.length || peers.some(peer => !currentKeys.has(peerKey(peer))))
    throw new Error('The trusted Glyph windows changed during the working-copy check. Preview the skill change again.');
}
