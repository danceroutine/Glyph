import { Duplex, PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditOperation } from '../../editing/proposals/EditOperation.ts';
import { EditProposalService } from '../../editing/proposals/EditProposalService.ts';
import { ProposalReviewManager } from '../../editing/reviews/ProposalReviewManager.ts';
import { FileProposalReviewStore } from '../../editing/reviews/persistence/FileProposalReviewStore.ts';
import { JsDiffTextDiffer } from '../../editing/documents/JsDiffTextDiffer.ts';
import type { EditingConfiguration } from '../../editing/configuration/EditingConfiguration.ts';
import { FileSystemWorkspaceTextStore } from '../../workspace/FileSystemWorkspaceTextStore.ts';
import { TerminalEditReviewer } from '../TerminalEditReviewer.ts';
import { TerminalInput } from '../TerminalInput.ts';

const paths: string[] = [];
const originalFetch = globalThis.fetch;
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576, maxChangedBytes: 1_048_576, maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64, maxTotalHunks: 256, maxHunksPerFile: 64, diffBudgetMs: 1_000, maxActiveReviews: 1,
  newFileByteOrderMark: false, newFileLineEnding: '\n',
};

beforeEach(() => {
  globalThis.fetch = async () => { throw new Error('Network access is forbidden in terminal editing E2E tests.'); };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(TerminalEditReviewer, () => {
describe(TerminalEditReviewer.prototype.review, () => {
it('accepts with Y through a virtual TTY and always restores raw mode and the alternate screen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-review-root-'));
  const state = await mkdtemp(join(tmpdir(), 'terminal-review-state-'));
  paths.push(root, state);
  await writeFile(join(root, 'file.txt'), 'base\n');
  const workspace = new FileSystemWorkspaceTextStore(root);
  const base = await workspace.read('file.txt');
  const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
  const proposal = await proposals.proposeStructured({ files: [{
    operation: EditOperation.UPDATE, path: 'file.txt', new_path: null, base_revision: base.revision, content: 'changed\n', byte_order_mark: null, edits: [],
  }] });
  const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
  await manager.stage(proposal);
  const tty = new VirtualTTY();
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  output.columns = 80;
  output.rows = 24;
  let rendered = '';
  output.on('data', chunk => { rendered += String(chunk); });
  const input = new TerminalInput(tty, output);
  const reviewer = new TerminalEditReviewer(input, output);

  const reviewing = reviewer.review(manager, new AbortController().signal);
  setImmediate(() => tty.push('Y'));
  await reviewing;

  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('changed\n');
  expect(tty.rawTransitions).toEqual([true, false]);
  expect(rendered).toContain('\x1b[?1049h');
  expect(rendered).toContain('\x1b[?1049l');
  input.close();
});

it('supports scrolling, file navigation, defer, and reopening without resolving pending items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-navigation-root-'));
  const state = await mkdtemp(join(tmpdir(), 'terminal-navigation-state-'));
  paths.push(root, state);
  await writeFile(join(root, 'a.txt'), 'a\nmiddle\nz\n');
  await writeFile(join(root, 'b.txt'), 'b\n');
  const workspace = new FileSystemWorkspaceTextStore(root);
  const [a, b] = await Promise.all([workspace.read('a.txt'), workspace.read('b.txt')]);
  const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
  const proposal = await proposals.proposeStructured({ files: [
    { operation: EditOperation.UPDATE, path: 'a.txt', new_path: null, base_revision: a.revision, content: 'A\nmiddle\nZ\n', byte_order_mark: null, edits: [] },
    { operation: EditOperation.UPDATE, path: 'b.txt', new_path: null, base_revision: b.revision, content: 'B\n', byte_order_mark: null, edits: [] },
  ] });
  const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
  await manager.stage(proposal);
  const tty = new VirtualTTY();
  const output = terminalOutput();
  const input = new TerminalInput(tty, output);
  const reviewer = new TerminalEditReviewer(input, output);

  driveOnRender(output, tty, ['j', 'l', 'h', ']', 'c', 'q']);
  await reviewer.review(manager, new AbortController().signal);
  expect(manager.active?.files.flatMap(file => file.items).every(item => item.decision === 'PENDING')).toBe(true);

  driveOnRender(output, tty, manager.active!.files.flatMap(file => file.items).map(() => 'N'));
  await reviewer.review(manager, new AbortController().signal);
  expect(manager.active).toBeUndefined();
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\nmiddle\nz\n');
  expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n');
  input.close();
});

it('restores the terminal when an acceptance detects a stale collaborator edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-stale-root-'));
  const state = await mkdtemp(join(tmpdir(), 'terminal-stale-state-'));
  paths.push(root, state);
  await writeFile(join(root, 'file.txt'), 'base');
  const workspace = new FileSystemWorkspaceTextStore(root);
  const base = await workspace.read('file.txt');
  const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
  const proposal = await proposals.proposeStructured({ files: [{
    operation: EditOperation.UPDATE, path: 'file.txt', new_path: null, base_revision: base.revision, content: 'agent', byte_order_mark: null, edits: [],
  }] });
  const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
  await manager.stage(proposal);
  await writeFile(join(root, 'file.txt'), 'collaborator');
  const tty = new VirtualTTY();
  const output = terminalOutput();
  let rendered = '';
  output.on('data', chunk => { rendered += String(chunk); });
  const input = new TerminalInput(tty, output);
  driveOnRender(output, tty, ['Y', 'Q']);

  await new TerminalEditReviewer(input, output).review(manager, new AbortController().signal);
  expect(rendered).toMatch(/Error: The file changed/);
  expect(rendered).toContain('\x1b[?1049l');
  expect(tty.rawTransitions.at(-1)).toBe(false);
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator');
  input.close();
});
});
});

class VirtualTTY extends Duplex {
  readonly isTTY = true;
  readonly rawTransitions: boolean[] = [];
  setRawMode(enabled: boolean): void { this.rawTransitions.push(enabled); }
  _read(): void {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(); }
}

function terminalOutput(): PassThrough & { columns?: number; rows?: number } {
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  output.columns = 80;
  output.rows = 24;
  return output;
}

function driveOnRender(output: PassThrough, tty: VirtualTTY, keys: string[]): void {
  let index = 0;
  output.on('data', chunk => {
    if (!String(chunk).includes('Y accept') || index >= keys.length) return;
    const key = keys[index++]!;
    queueMicrotask(() => tty.push(key));
  });
}
