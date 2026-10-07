import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '../../../observability/NullLogger.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import type { EditingConfiguration } from '../../configuration/EditingConfiguration.ts';
import { JsDiffTextDiffer } from '../../documents/JsDiffTextDiffer.ts';
import { EditOperation } from '../../proposals/EditOperation.ts';
import { EditProposalService } from '../../proposals/EditProposalService.ts';
import { EditDecisionState } from '../EditDecisionState.ts';
import { ProposalReviewManager } from '../ProposalReviewManager.ts';
import { FileProposalReviewStore } from '../persistence/FileProposalReviewStore.ts';

const directories: string[] = [];
const configuration: EditingConfiguration = {
  maxRawProposalBytes: 1_048_576,
  maxChangedBytes: 1_048_576,
  maxResultingBytesPerFile: 1_048_576,
  maxFiles: 64,
  maxTotalHunks: 256,
  maxHunksPerFile: 64,
  diffBudgetMs: 1_000,
  maxActiveReviews: 8,
  newFileByteOrderMark: false,
  newFileLineEnding: '\n',
};

afterEach(async () => Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));

describe(ProposalReviewManager, () => {
  describe('adversarial state-machine transitions', () => {
    it('matches an independent document model across shuffled decisions, human edits, and restarts', async () => {
      for (let seed = 1; seed <= 24; seed++) {
        const root = await mkdtemp(join(tmpdir(), `proposal-model-root-${seed}-`));
        const state = await mkdtemp(join(tmpdir(), `proposal-model-state-${seed}-`));
        directories.push(root, state);
        const original = Array.from(
          { length: 8 },
          (_, index) => `${agentSource(index)}\n${humanSource(index)}\ncontext-${index}\n`,
        ).join('');
        await writeFile(join(root, 'file.txt'), original);

        const workspace = new FileSystemWorkspaceTextStore(root);
        const service = new EditProposalService(workspace, new JsDiffTextDiffer(), configuration, new NullLogger());
        const base = await workspace.read('file.txt');
        const proposal = await service.proposeStructured({
          files: [
            {
              operation: EditOperation.UPDATE,
              path: 'file.txt',
              new_path: null,
              base_revision: base.revision,
              content: null,
              byte_order_mark: null,
              edits: Array.from({ length: 8 }, (_, index) => ({
                range: {
                  start: { line: index * 3, character: 0 },
                  end: { line: index * 3, character: agentSource(index).length },
                },
                expected_text: agentSource(index),
                replacement_text: agentReplacement(seed, index),
              })),
            },
          ],
        });
        let manager = managerFor(root, state);
        await manager.stage(proposal);

        const random = pseudoRandom(seed);
        const order = shuffledIndices(8, random);
        const decisions = order.map(() =>
          random() % 4 === 0 ? EditDecisionState.REJECTED : EditDecisionState.ACCEPTED,
        );
        let expectedText = original;

        for (let step = 0; step < order.length; step++) {
          const itemIndex = order[step]!;
          const humanText = humanReplacement(seed, step);
          expectedText = expectedText.replace(`${humanSource(step)}\n`, `${humanText}\n`);
          await writeFile(join(root, 'file.txt'), expectedText);

          if (step === 2 || step === 5) {
            manager = managerFor(root, state);
            await manager.initialize();
          }

          const item = manager.activeReviews[0]!.files[0]!.items.find(
            candidate => candidate.removedText === `${agentSource(itemIndex)}\n`,
          )!;
          if (decisions[step] === EditDecisionState.ACCEPTED) {
            await manager.accept(item.id);
            expectedText = expectedText.replace(
              `${agentSource(itemIndex)}\n`,
              `${agentReplacement(seed, itemIndex)}\n`,
            );
          } else {
            await manager.reject(item.id);
          }

          expect(await readFile(join(root, 'file.txt'), 'utf8'), `seed ${seed}, step ${step}`).toBe(expectedText);
          if (step < order.length - 1) {
            const actualDecisions = manager.activeReviews[0]!.files[0]!.items.map(candidate => candidate.decision);
            for (let settledStep = 0; settledStep <= step; settledStep++) {
              expect(actualDecisions[order[settledStep]!], `seed ${seed}, settled step ${settledStep}`).toBe(
                decisions[settledStep],
              );
            }
          }
        }

        expect(manager.activeReviews, `seed ${seed}`).toStrictEqual([]);
        await manager.acknowledgeResults(manager.pendingResults.map(result => result.id));
        await expect(readFile(join(state, 'active-proposal-review.json'), 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    }, 15_000);
  });
});

function managerFor(root: string, state: string): ProposalReviewManager {
  return new ProposalReviewManager(
    new FileSystemWorkspaceTextStore(root),
    new FileProposalReviewStore(state),
    new NullLogger(),
    8,
  );
}

function pseudoRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value;
  };
}

function shuffledIndices(count: number, random: () => number): number[] {
  const result = Array.from({ length: count }, (_, index) => index);
  for (let index = result.length - 1; index > 0; index--) {
    const swap = random() % (index + 1);
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function agentSource(index: number): string {
  return `agent-${index}`;
}

function agentReplacement(seed: number, index: number): string {
  return `AGENT-${seed}-${index}-${'x'.repeat(index + 1)}`;
}

function humanSource(index: number): string {
  return `human-${index}`;
}

function humanReplacement(seed: number, index: number): string {
  return `human-${seed}-${index}-${'y'.repeat(seed + index)}`;
}
