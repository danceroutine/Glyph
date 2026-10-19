import { AgentModeID } from "#src/chat/AgentMode.js";
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import type { ProjectAccess } from '#src/project/ProjectAccess.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { ProjectToolRuntime } from '#src/project/ProjectToolRuntime.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-edits-'));
  directories.push(root);
  const workspace = new FileSystemWorkspaceTextStore(root);
  const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), {
    maxRawProposalBytes: 1024 * 1024,
    maxChangedBytes: 1024 * 1024,
    maxResultingBytesPerFile: 1024 * 1024,
    maxFiles: 64,
    maxTotalHunks: 256,
    maxHunksPerFile: 64,
    diffBudgetMs: 1000,
    maxActiveReviews: 1,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  });
  const stage = vi.fn(async () => {});
  const runtime = new ProjectToolRuntime({ definitions: [] } as unknown as ProjectAccess, proposals, {
    stage,
    activeReviews: [],
  } as unknown as ProposalReviewManager);
  return { root, workspace, stage, runtime };
}
const create = (path: string) => ({
  operation: 'CREATE',
  path,
  new_path: null,
  base_revision: null,
  content: '# Plan\n',
  byte_order_mark: false,
  edits: [],
});
it.each(['propose_patch', 'propose_edits'])(
  'allows Markdown-only %s and rejects mixed proposals before staging any files',
  async tool => {
    const f = await fixture();
    const input = (paths: string[]) =>
      tool === 'propose_patch'
        ? ['*** Begin Patch', ...paths.flatMap(path => [`*** Add File: ${path}`, '+# Plan']), '*** End Patch'].join(
            '\n',
          )
        : JSON.stringify({ files: paths.map(create) });
    const allowed = JSON.parse(
      await f.runtime.execute(tool, input(['plan.md', 'notes.MARKDOWN']), undefined, { mode: AgentModeID.PLAN }),
    );
    expect(allowed.status).toBe('STAGED_FOR_REVIEW');
    expect(f.stage).toHaveBeenCalledTimes(1);
    f.stage.mockClear();
    for (const path of ['index.ts', 'plan.md.ts', 'package.json', '.env']) {
      const denied = JSON.parse(
        await f.runtime.execute(tool, input(['plan.md', path]), undefined, { mode: AgentModeID.PLAN }),
      );
      expect(denied.error.message).toMatch(path === '.env' ? /excluded from project access/ : /only edit Markdown/);
    }
    expect(f.stage).not.toHaveBeenCalled();
  },
);
it.each([
  ['source.ts', 'target.md'],
  ['source.md', 'target.ts'],
  ['source.md', 'target.markdown'],
])('checks both ends of rename %s to %s', async (source, target) => {
  const f = await fixture();
  await writeFile(join(f.root, source), 'base');
  const base = await f.workspace.read(source);
  const output = JSON.parse(
    await f.runtime.execute(
      'propose_edits',
      JSON.stringify({
        files: [
          { ...create(source), operation: 'RENAME', new_path: target, base_revision: base.revision, content: null },
        ],
      }),
      undefined,
      { mode: AgentModeID.PLAN },
    ),
  );
  if (source.endsWith('.ts') || target.endsWith('.ts')) {
    expect(output.error.message).toContain('only edit Markdown');
    expect(f.stage).not.toHaveBeenCalled();
  } else expect(output.status).toBe('STAGED_FOR_REVIEW');
  expect(await readFile(join(f.root, source), 'utf8')).toBe('base');
});
it('checks resolved paths so a Markdown alias cannot target a non-Markdown file', async () => {
  const f = await fixture();
  const canonical = f.workspace.canonicalPath.bind(f.workspace);
  vi.spyOn(f.workspace, 'canonicalPath').mockImplementation(path =>
    path === 'alias.md' ? Promise.resolve(join(f.root, 'source.ts')) : canonical(path),
  );
  const output = JSON.parse(
    await f.runtime.execute('propose_edits', JSON.stringify({ files: [create('alias.md')] }), undefined, {
      mode: AgentModeID.PLAN,
    }),
  );
  expect(output.error.message).toContain('only edit Markdown');
  expect(f.stage).not.toHaveBeenCalled();
});
it('keeps code edits available in Agent mode', async () => {
  const f = await fixture();
  const output = JSON.parse(
    await f.runtime.execute('propose_edits', JSON.stringify({ files: [create('index.ts')] }), undefined, {
      mode: AgentModeID.AGENT,
    }),
  );
  expect(output.status).toBe('STAGED_FOR_REVIEW');
});
