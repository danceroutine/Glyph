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
  const namePolicy = { caseSensitive: false, normalizesUnicode: true, foldsUnicode: true };
  await assertSkillPackageClean(
    { request, trustedSkillEditors: registry },
    identity,
    'project',
    '/physical/.glyph/skills/example',
    'file:///logical/.glyph/skills/example',
    [],
    namePolicy,
  );
  expect(request.mock.calls.map(([, command]) => command)).toEqual([
    {
      operationId: expect.any(String),
      type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
      scope: 'project',
      namePolicy,
      physicalPackageUri: 'file:///physical/.glyph/skills/example',
      directoryUri: 'file:///logical/.glyph/skills/example',
    },
    {
      operationId: expect.any(String),
      type: GlyphEditorRequestType.CHECK_SKILL_WORKING_COPIES,
      scope: 'project',
      namePolicy,
      physicalPackageUri: 'file:///physical/.glyph/skills/example',
      directoryUri: peer.directoryUri,
      peerWorkspaceIntersection: true,
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
it('revalidates every logical intersection when one connection covers multiple package subtrees', async () => {
  const peer = {
    identity: { ...identity, windowId: 'peer' },
    connectionId: 'peer',
    directoryUri: 'file:///alias/refs',
  };
  const second = { ...peer, directoryUri: 'file:///alias/scripts' };
  const registry = vi.fn(() => [peer, second]);
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  const check = () =>
    assertSkillPackageClean(
      { request, trustedSkillEditors: registry },
      identity,
      'project',
      '/project/.glyph/skills/example',
    );
  registry.mockReturnValueOnce([peer, second]).mockReturnValueOnce([second, peer]);
  await check();
  expect(request).toHaveBeenCalledTimes(3);
  registry
    .mockReturnValueOnce([peer, second])
    .mockReturnValueOnce([peer, { ...second, directoryUri: 'file:///new-alias' }]);
  await expect(check()).rejects.toThrow('windows changed');
});
it('requires an absolute host-authorized project package', async () => {
  const request = vi.fn<EditorRpcRouter['request']>();
  await expect(
    assertSkillPackageClean({ request, trustedSkillEditors: () => [] }, identity, 'project', 'relative'),
  ).rejects.toThrow('absolute');
  expect(request).not.toHaveBeenCalled();
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

it('sends each recipient its physical mount route and rechecks mount changes before returning', async () => {
  const peer = {
    identity: { ...identity, windowId: 'peer' },
    connectionId: 'peer',
    directoryUri: 'file:///editor/work',
    physicalPackageUri: 'file:///mount/one',
  };
  const registry = vi.fn(() => [peer]);
  const request = vi.fn<EditorRpcRouter['request']>(async (_identity, input) => ({
    operationId: 'operationId' in input ? input.operationId : '',
    ok: true,
    packageClean: true,
  }));
  const intersection = { directoryUri: 'file:///owner/one', physicalPackageUri: 'file:///owner-mount/one' };
  const check = () =>
    assertSkillPackageClean(
      { request, trustedSkillEditors: registry },
      identity,
      'project',
      '/source/one',
      undefined,
      [intersection, intersection, 'file:///owner/another'],
      undefined,
      ['/mount/one'],
    );
  await check();
  expect(registry).toHaveBeenCalledWith(identity, '/source/one', ['/mount/one']);
  expect(request.mock.calls.map(([, cmd]) => cmd)).toMatchObject([
    { physicalPackageUri: 'file:///source/one' },
    intersection,
    { directoryUri: 'file:///owner/another', physicalPackageUri: 'file:///source/one' },
    { physicalPackageUri: peer.physicalPackageUri },
  ]);
  registry.mockReturnValueOnce([peer]).mockReturnValueOnce([{ ...peer, physicalPackageUri: 'file:///other/one' }]);
  await expect(check()).rejects.toThrow('windows changed');
});
