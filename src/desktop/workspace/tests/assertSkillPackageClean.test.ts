import { it, expect, vi } from 'vitest';
import { assertSkillPackageClean } from '../assertSkillPackageClean.ts';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from '../EditorRpcRouter.ts';
const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'owner' };
it('sends only the owning window and approved directory to the working-copy guard', async () => {
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  await assertSkillPackageClean({ request }, identity, 'user', '/home/user/.glyph/skills/example');
  expect(request).toHaveBeenCalledWith(identity, {
    operationId: expect.any(String),
    type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
    scope: 'user',
    directoryUri: 'file:///home/user/.glyph/skills/example',
  });
  await expect(assertSkillPackageClean({ request }, identity, 'project', 'relative')).rejects.toThrow('absolute');
});
it('requires a correlated clean response and fails closed on dirty, unavailable, or malformed replies', async () => {
  for (const response of [
    { ok: true, packageClean: false },
    { ok: false },
    { ok: true },
    { operationId: 'wrong', ok: true, packageClean: true },
  ]) {
    const request: EditorRpcRouter['request'] = async (_identity, input) => ({
      operationId: 'operationId' in input ? input.operationId : '',
      ...response,
    });
    await expect(
      assertSkillPackageClean({ request }, identity, 'project', '/workspace/.glyph/skills/example'),
    ).rejects.toThrow();
  }
});
