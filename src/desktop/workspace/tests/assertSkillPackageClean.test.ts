import { it, expect, vi } from 'vitest';
import { assertSkillPackageClean } from '#src/desktop/workspace/assertSkillPackageClean.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'owner' };
it('checks the owner and overlapping peer through each editor’s authorized logical project URI', async () => {
  const peer = {
    identity: { ...identity, windowId: 'peer' },
    connectionId: 'peer',
    directoryUri: 'file:///alias/.glyph/skills/example',
  };
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  const registry = vi.fn(() => [peer]);
  await assertSkillPackageClean(
    { request, trustedSkillEditors: registry },
    identity,
    'project',
    '/physical/.glyph/skills/example',
    'file:///logical/.glyph/skills/example',
  );
  expect(request.mock.calls.map(([, command]) => command)).toEqual([
    {
      operationId: expect.any(String),
      type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
      scope: 'project',
      directoryUri: 'file:///logical/.glyph/skills/example',
    },
    {
      operationId: expect.any(String),
      type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
      scope: 'project',
      directoryUri: peer.directoryUri,
    },
  ]);
  const missingDirectory = () => [{ identity: peer.identity, connectionId: peer.connectionId }];
  await expect(
    assertSkillPackageClean(
      { request, trustedSkillEditors: missingDirectory },
      identity,
      'project',
      '/physical/.glyph/skills/example',
    ),
  ).rejects.toThrow('peer project destination');
});
it('sends only the owning window and approved directory to the working-copy guard', async () => {
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  await assertSkillPackageClean(
    { request, trustedSkillEditors: () => [] },
    identity,
    'user',
    '/home/user/.glyph/skills/example',
  );
  expect(request).toHaveBeenCalledWith(identity, {
    operationId: expect.any(String),
    type: GlyphEditorRequestType.CHECK_USER_SKILL_WORKING_COPIES,
    packageName: 'example',
  });
  await expect(
    assertSkillPackageClean({ request, trustedSkillEditors: () => [] }, identity, 'project', 'relative'),
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
        { request, trustedSkillEditors: () => [] },
        identity,
        'project',
        '/workspace/.glyph/skills/example',
      ),
    ).rejects.toThrow();
  }
});

it('queries same-profile peers by package basename and refuses dirty, unavailable or changed peers', async () => {
  const peer = { identity: { ...identity, windowId: 'peer' }, connectionId: 'peer-connection' };
  const trustedSkillEditors = vi.fn(() => [peer]);
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  const editors = { request, trustedSkillEditors };
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
  trustedSkillEditors.mockReturnValueOnce([peer]).mockReturnValueOnce([]);
  await expect(check()).rejects.toThrow('windows changed');
  trustedSkillEditors
    .mockReturnValueOnce([peer])
    .mockReturnValueOnce([{ ...peer, connectionId: 'different-connection' }]);
  await expect(check()).rejects.toThrow('windows changed');
  trustedSkillEditors.mockReturnValue([]);
  const previous = request.mock.calls.length;
  await assertSkillPackageClean(editors, identity, 'project', '/workspace/.glyph/skills/example');
  expect(request).toHaveBeenCalledTimes(previous + 1);
});
