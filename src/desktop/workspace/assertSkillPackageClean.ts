import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from './EditorRpcRouter.ts';

/** Checks unsaved editor state for a host-authorized physical package destination. No buffer contents leave the editor. */
export async function assertSkillPackageClean(
  editors: Pick<EditorRpcRouter, 'request'>,
  identity: GlyphConnectionIdentity,
  scope: 'user' | 'project',
  absolutePackageDirectory: string,
): Promise<void> {
  if (!isAbsolute(absolutePackageDirectory))
    throw new Error('Skill working-copy checks require an absolute package directory.');
  const operationId = randomUUID();
  const response = await editors.request(identity, {
    operationId,
    type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
    scope,
    directoryUri: pathToFileURL(absolutePackageDirectory).toString(),
  });
  if (response.operationId !== operationId || !response.ok || typeof response.packageClean !== 'boolean')
    throw new Error(response.error?.message ?? 'The editor could not verify the skill working copies.');
  if (!response.packageClean) throw new Error('Save or discard unsaved skill edits before managing the package.');
}
