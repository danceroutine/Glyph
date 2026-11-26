import { it, expect, vi } from 'vitest';
import { assertSkillPackageClean } from '#src/desktop/workspace/assertSkillPackageClean.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'owner' };
it('sends only the owning window and approved directory to the working-copy guard', async () => {
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  await assertSkillPackageClean(
    { request, trustedUserSkillPeers: () => [] },
    identity,
    'user',
    '/home/user/.glyph/skills/example',
  );
  expect(request).toHaveBeenCalledWith(identity, {
    operationId: expect.any(String),
    type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
    scope: 'user',
    directoryUri: 'file:///home/user/.glyph/skills/example',
  });
  await expect(
    assertSkillPackageClean({ request, trustedUserSkillPeers: () => [] }, identity, 'project', 'relative'),
  ).rejects.toThrow('absolute');
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
      assertSkillPackageClean(
        { request, trustedUserSkillPeers: () => [] },
        identity,
        'project',
        '/workspace/.glyph/skills/example',
      ),
    ).rejects.toThrow();
  }
});

it('queries same-profile peers by package basename and refuses dirty, unavailable or changed peers', async () => {
  const peer = { identity: { ...identity, windowId: 'peer' }, connectionId: 'peer-connection' };
  const trustedUserSkillPeers = vi.fn(() => [peer]);
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  const editors = { request, trustedUserSkillPeers };
  const check = () => assertSkillPackageClean(editors, identity, 'user', '/private/user-profile/.glyph/skills/example');
  await check();
  expect(request.mock.calls.find(([who]) => who === peer.identity)?.[1]).toEqual({
    operationId: expect.any(String),
    type: GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES,
    packageName: 'example',
  });
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (who, input) =>
    who === peer.identity ? { ...(await normal(who, input)), packageClean: false } : normal(who, input),
  );
  await expect(check()).rejects.toThrow('unsaved');
  request.mockImplementation(async (who, input) => {
    if (who === peer.identity) throw new Error('peer unavailable');
    return normal(who, input);
  });
  await expect(check()).rejects.toThrow('peer unavailable');
  request.mockImplementation(normal);
  trustedUserSkillPeers.mockReturnValueOnce([peer]).mockReturnValueOnce([]);
  await expect(check()).rejects.toThrow('windows changed');
  trustedUserSkillPeers
    .mockReturnValueOnce([peer])
    .mockReturnValueOnce([{ ...peer, connectionId: 'different-connection' }]);
  await expect(check()).rejects.toThrow('windows changed');
  const previous = request.mock.calls.length;
  await assertSkillPackageClean(editors, identity, 'project', '/workspace/.glyph/skills/example');
  expect(request).toHaveBeenCalledTimes(previous + 1);
});
