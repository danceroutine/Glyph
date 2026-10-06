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
import { TerminalUI } from '../TerminalUI.tsx';

const paths: string[] = [];
const originalFetch = globalThis.fetch;
const originalNoColor = process.env.NO_COLOR;
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576,
  maxChangedBytes: 1_048_576,
  maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 1,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

beforeEach(() => {
  delete process.env.NO_COLOR;
  globalThis.fetch = async () => {
    throw new Error('Network access is forbidden in terminal editing E2E tests.');
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(TerminalEditReviewer, () => {
  describe(TerminalEditReviewer.prototype.review, () => {
    it('accepts with Y through Ink and always restores raw mode', async () => {
      const root = await mkdtemp(join(tmpdir(), 'terminal-review-root-'));
      const state = await mkdtemp(join(tmpdir(), 'terminal-review-state-'));
      paths.push(root, state);
      await writeFile(join(root, 'file.ts'), 'const answer: number = 1;\n');
      const workspace = new FileSystemWorkspaceTextStore(root);
      const base = await workspace.read('file.ts');
      const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const proposal = await proposals.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.ts',
            new_path: null,
            base_revision: base.revision,
            content: 'const answer: number = 2;\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
      await manager.stage(proposal);
      const tty = new VirtualTTY();
      const output = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
      output.columns = 80;
      output.rows = 24;
      output.isTTY = true;
      let rendered = '';
      output.on('data', chunk => {
        rendered += String(chunk);
      });
      const ui = new TerminalUI(tty, output, output);
      const reviewer = new TerminalEditReviewer(ui);

      const reviewing = reviewer.review(manager, new AbortController().signal);
      await waitUntil(() => tty.rawTransitions.at(-1) === true && rendered.includes('Y accept'));
      tty.push('Y');
      await reviewing;

      expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('const answer: number = 2;\n');
      expect(tty.rawTransitions).toEqual([true, false]);
      expect(rendered).toContain('\x1b[48;5;52m');
      expect(rendered).toContain('\x1b[48;5;22m');
      expect(rendered).toContain('\x1b[35mconst\x1b[39m');
      ui.close();
    });

    it('appends multi-actor proposals to one navigable queue and can expand a change into full-file context', async () => {
      const root = await mkdtemp(join(tmpdir(), 'terminal-navigation-root-'));
      const state = await mkdtemp(join(tmpdir(), 'terminal-navigation-state-'));
      paths.push(root, state);
      await writeFile(
        join(root, 'a.txt'),
        'a\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nfar-away-context\nline 9\nline 10\nz\n',
      );
      await writeFile(join(root, 'b.txt'), 'b\n');
      const workspace = new FileSystemWorkspaceTextStore(root);
      const [a, b] = await Promise.all([workspace.read('a.txt'), workspace.read('b.txt')]);
      const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const proposal = await proposals.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'a.txt',
            new_path: null,
            base_revision: a.revision,
            content: 'A\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nfar-away-context\nline 9\nline 10\nZ\n',
            byte_order_mark: null,
            edits: [],
          },
          {
            operation: EditOperation.UPDATE,
            path: 'b.txt',
            new_path: null,
            base_revision: b.revision,
            content: 'B\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
      await manager.stage(proposal);
      const appendedProposal = await proposals.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'c.txt',
            new_path: null,
            base_revision: null,
            content: 'C\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await manager.stage(appendedProposal);
      const tty = new VirtualTTY();
      const output = terminalOutput();
      let rendered = '';
      output.on('data', chunk => {
        rendered += String(chunk);
      });
      const ui = new TerminalUI(tty, output, output);
      const reviewer = new TerminalEditReviewer(ui);

      const firstReview = reviewer.review(manager, new AbortController().signal);
      await waitUntil(() => rendered.includes('Y accept'));
      await sendKeys(tty, ['\x1b[B', '\x1b[C', '\x1b[D', 'F', '\x1b[6~', '\x1b[5~', '\x1b[F', '\x1b[H', 'q']);
      await firstReview;
      expect(manager.active?.files.flatMap(file => file.items).every(item => item.decision === 'PENDING')).toBe(true);
      expect(rendered).toContain('full file');
      expect(rendered).toContain('far-away-context');
      expect(rendered).toContain('File 1/3  change 1/2');
      expect(rendered).toContain('←/→ previous/next change');
      expect(rendered).not.toContain('j/k scroll');
      expect(rendered).not.toContain('[c/]c change');
      expect(rendered).not.toContain('gg/G ends');

      const secondReview = reviewer.review(manager, new AbortController().signal);
      await waitUntil(() => tty.rawTransitions.at(-1) === true);
      await sendKeys(
        tty,
        manager.activeReviews.flatMap(review => review.files.flatMap(file => file.items)).map(() => 'N'),
      );
      await secondReview;
      expect(manager.activeReviews).toEqual([]);
      expect(rendered).toContain('CREATE c.txt');
      expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(
        'a\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nfar-away-context\nline 9\nline 10\nz\n',
      );
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n');
      await expect(readFile(join(root, 'c.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      ui.close();
    });

    it('restores the terminal when an acceptance detects a stale collaborator edit', async () => {
      const root = await mkdtemp(join(tmpdir(), 'terminal-stale-root-'));
      const state = await mkdtemp(join(tmpdir(), 'terminal-stale-state-'));
      paths.push(root, state);
      await writeFile(join(root, 'file.txt'), 'base');
      const workspace = new FileSystemWorkspaceTextStore(root);
      const base = await workspace.read('file.txt');
      const proposals = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration);
      const proposal = await proposals.proposeStructured({
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: base.revision,
            content: 'agent',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      const manager = new ProposalReviewManager(workspace, new FileProposalReviewStore(state));
      await manager.stage(proposal);
      await writeFile(join(root, 'file.txt'), 'collaborator');
      const tty = new VirtualTTY();
      const output = terminalOutput();
      let rendered = '';
      output.on('data', chunk => {
        rendered += String(chunk);
      });
      const ui = new TerminalUI(tty, output, output);
      const review = new TerminalEditReviewer(ui).review(manager, new AbortController().signal);
      await waitUntil(() => rendered.includes('Y accept'));
      tty.push('Y');
      await waitUntil(() => rendered.includes('Error: The file changed'));
      tty.push('Q');
      await review;
      expect(rendered).toMatch(/Error: The file changed/);
      expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('collaborator');
      ui.close();
      expect(tty.rawTransitions.at(-1)).toBe(false);
    });
  });
});

class VirtualTTY extends Duplex {
  readonly isTTY = true;
  readonly rawTransitions: boolean[] = [];
  setRawMode(enabled: boolean): void {
    this.rawTransitions.push(enabled);
  }
  _read(): void {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function terminalOutput(): PassThrough & { columns?: number; rows?: number; isTTY?: boolean } {
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number; isTTY?: boolean };
  output.columns = 80;
  output.rows = 24;
  output.isTTY = true;
  return output;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Condition was not reached.');
}

async function sendKeys(tty: VirtualTTY, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    tty.push(key);
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
}
