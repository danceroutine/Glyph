import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GlyphService } from '#src/application/GlyphService.js';
import { OpenAIDesktopRuntimeFactory } from '#src/desktop/host/OpenAIDesktopRuntimeFactory.js';
import { EditorRpcRouter } from '#src/desktop/workspace/EditorRpcRouter.js';
import { contentRevision } from '#src/desktop/workspace/EditorWorkspaceTextStore.js';
import { GlyphEditorRequestType } from '#src/desktop/protocol/editor/GlyphEditorRequest.js';

describe(OpenAIDesktopRuntimeFactory, () => {
  it('[round2-10] applies read budgets to a smaller unsaved editor buffer instead of its oversized disk version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-live-read-budget-'));
    const root = join(directory, 'workspace');
    await mkdir(root);
    await writeFile(join(root, 'file.txt'), 'old disk content'.repeat(100));
    vi.stubEnv('GLYPH_CONFIG_DIR', join(directory, 'state'));
    vi.stubEnv('CHAT_TRACE_FILE', join(directory, 'trace.log'));
    vi.stubEnv('CONTEXT_MAX_FILE_BYTES', '32');
    const services: GlyphService[] = [];
    vi.spyOn(GlyphService.prototype, 'initialize').mockImplementation(async function (this: GlyphService) {
      services.push(this);
    });
    const editor = new EditorRpcRouter();
    const request = vi.spyOn(editor, 'request').mockImplementation(async (_identity, request) => {
      expect(request.type).toBe(GlyphEditorRequestType.READ_SNAPSHOT);
      return {
        operationId:
          request.type === GlyphEditorRequestType.APPLY_TEXT_MUTATION
            ? request.mutation.operationId
            : request.operationId,
        ok: true,
        snapshot: {
          uri: 'file:///fixture/file.txt',
          path: 'file.txt',
          text: 'tiny',
          contentRevision: contentRevision('tiny', false),
          byteLength: 4,
          byteOrderMark: false,
          mode: 0o644,
          identity: 'fixture',
          dirty: true,
          token: {
            workspaceGeneration: 'workspace',
            resource: 'file:///fixture/file.txt',
            incarnation: 'model',
            version: 1,
          },
        },
      };
    });
    const factory = new OpenAIDesktopRuntimeFactory(editor);
    let runtime: Awaited<ReturnType<typeof factory.create>> | undefined;
    try {
      runtime = await factory.create({
        identity: { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' },
        roots: [{ name: 'workspace', canonicalPath: root, uri: `file://${root}` }],
        emit: () => {},
      });
      const service = services[0]!;
      await expect(service.resolveChatRequest('Read my buffer', [{ path: 'file.txt' }])).resolves.toMatchObject({
        attachments: [{ text: 'tiny', byteLength: 4 }],
      });
      expect(request).toHaveBeenCalledOnce();
      expect(request.mock.calls[0]?.[1]).toMatchObject({ maxBytes: 32 });
      // Metadata-only validation must not turn editor RPC into a policy bypass.
      await writeFile(join(root, '.env'), 'harmless excluded fixture');
      await symlink(join(root, 'file.txt'), join(root, 'alias.txt'));
      await expect(service.resolveChatRequest('Excluded', [{ path: '.env' }])).rejects.toThrow();
      await expect(service.resolveChatRequest('Symlink', [{ path: 'alias.txt' }])).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      await runtime?.dispose();
      await factory.dispose();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
