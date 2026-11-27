import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi, onTestFinished } from 'vitest';
import { assertUserWorkingCopiesClean } from '#src/desktop/workspace/assertUserWorkingCopiesClean.js';
import { GlyphEditorRequestType, type GlyphEditorRequest } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphEditorResponse } from '#src/desktop/protocol/editor/GlyphEditorResponse.js';
import { GlyphDesktopErrorCode } from '#src/desktop/protocol/GlyphDesktopError.js';

const owner = { windowId: 'owner', workspaceId: 'workspace', profileId: 'one' };
const namePolicy = { caseSensitive: true, normalizesUnicode: true, foldsUnicode: false };
const other = { identity: { ...owner, windowId: 'peer' }, connectionId: 'peer-port' };
it('requires the matching affirmative response from every trusted editor and rechecks membership', async () => {
  const peers = vi.fn(() => [other]);
  const request = vi.fn(
    async (_identity: GlyphConnectionIdentity, input: GlyphEditorRequest): Promise<GlyphEditorResponse> => {
      expect(input).toMatchObject({
        type: GlyphEditorRequestType.CHECK_USER_WORKING_COPIES,
        kind: 'rule',
        name: 'x.mdc',
        caseSensitive: true,
        namePolicy,
      });
      return { ok: true, operationId: 'operationId' in input ? input.operationId : '', workingCopiesClean: true };
    },
  );
  const check = () =>
    assertUserWorkingCopiesClean({ request, trustedUserEditors: peers }, owner, 'rule', 'x.mdc', namePolicy);
  await check();
  expect(request.mock.calls.map(([identity]) => identity)).toEqual([owner, other.identity]);
  for (const reply of [
    { ok: false, error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, message: 'reconnect', retryable: true } },
    { ok: true, workingCopiesClean: false },
    { ok: true, workingCopiesClean: true, operationId: 'wrong' },
  ]) {
    request.mockImplementationOnce(async (_id, input) => ({
      operationId: 'operationId' in input ? input.operationId : '',
      ...reply,
    }));
    await expect(check()).rejects.toThrow(reply.error ? 'reconnect' : 'Save or discard');
  }
  for (const after of [[], [{ ...other, connectionId: 'replacement' }]]) {
    peers.mockReturnValueOnce([other]).mockReturnValueOnce(after);
    await expect(check()).rejects.toThrow('changed');
  }
});

it('rechecks the configured profile while dirty-editor requests are in flight', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-user-profile-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const [a, b, profile] = ['a', 'b', 'current'].map(name => join(root, name)) as [string, string, string];
  await Promise.all([mkdir(a), mkdir(b)]);
  await symlink(a, profile);
  const request = vi.fn(async (_owner: GlyphConnectionIdentity, input: GlyphEditorRequest) => {
    await rm(profile);
    await symlink(b, profile);
    return { ok: true, operationId: 'operationId' in input ? input.operationId : '', workingCopiesClean: true };
  });
  const check = () =>
    assertUserWorkingCopiesClean(
      { request, trustedUserEditors: () => [] },
      owner,
      'rule',
      'one.mdc',
      namePolicy,
      join(a, 'rules', 'one.mdc'),
      profile,
    );
  await expect(check()).rejects.toThrow('user directory changed');
  await expect(check()).rejects.toThrow('user directory changed');
  expect(request).toHaveBeenCalledTimes(1);
});
