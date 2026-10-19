import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReviewService } from '../AgentReviewService.ts';
import {
  AgentReviewScope,
  AgentReviewStatus as Status,
  type AgentReview,
  type AgentReviewInput,
} from '../AgentReview.ts';
import { SqliteAgentReviewStore } from '../SqliteAgentReviewStore.ts';
import type { AgentReviewExecutor } from '../AgentReviewExecutor.ts';
import type { AgentReviewStore } from '../AgentReviewStore.ts';
const model = { accountProvider: 'fixture', accountId: 'account', model: 'test-model' };
const input = (): AgentReviewInput => ({
  id: randomUUID(),
  repositoryUri: 'file:///workspace',
  scope: AgentReviewScope.LAST_COMMIT,
  branch: '',
  label: 'Last commit',
  files: [
    {
      path: 'file.ts',
      uri: 'file:///workspace/file.ts',
      before: 'const a = 1;\n',
      after: 'const a = 0;\n',
      contextText: 'captured comparison',
      revision: 'capture-1',
    },
  ],
});
const finding = {
  path: 'file.ts',
  line: 1,
  title: 'Zero divisor',
  body: 'A zero divisor makes the calculation invalid.',
};
const report = `<glyph_review>\n${JSON.stringify(finding)}\n{"complete":true}\n</glyph_review>\nOne issue.`;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function memoryStore(initial: readonly AgentReview[] = []): AgentReviewStore {
  const records = new Map(initial.map(review => [review.id, structuredClone(review)]));
  return {
    load: async () => [...records.values()],
    save: async review => {
      records.set(review.id, structuredClone(review));
    },
    dispose: async () => {},
  };
}
async function fixture(run: AgentReviewExecutor['run'], store = memoryStore()) {
  const service = new AgentReviewService(store, { run });
  await service.initialize();
  cleanup.push(() => service.dispose());
  return service;
}
it('streams validated findings, checkpoints before publishing, and deduplicates admission', async () => {
  const store = memoryStore();
  let release!: () => void;
  const run = vi.fn<AgentReviewExecutor['run']>(async (_, emit) => {
    emit(`<glyph_review>\n${JSON.stringify(finding)}\n`);
    await new Promise<void>(resolve => {
      release = resolve;
    });
    emit('{"complete":true}\n</glyph_review>\nOne issue.');
  });
  const service = await fixture(run, store);
  const request = input();
  await service.start(request, model);
  await service.start(request, model);
  await vi.waitFor(() => expect(service.reviews[0]?.findings).toHaveLength(1));
  expect((await store.load())[0]?.findings).toEqual(service.reviews[0]?.findings);
  expect(service.reviews[0]?.status).toBe(Status.RUNNING);
  expect(run).toHaveBeenCalledTimes(1);
  await expect(service.start(input(), model)).rejects.toThrow('already running');
  release();
  await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));
  expect(service.reviews[0]?.summary).toBe('One issue.');
});
it('persists captures, findings and dismissals across a new service and SQLite connection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'glyph-review-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'reviews.sqlite');
  const first = await fixture(async (_, emit) => {
    emit(report);
  }, new SqliteAgentReviewStore(path));
  await first.start(input(), model);
  await vi.waitFor(() => expect(first.reviews[0]?.status).toBe(Status.COMPLETED));
  const review = first.reviews[0]!;
  await first.dismiss(review.id, review.findings[0]!.id);
  await first.dispose();
  const run = vi.fn<AgentReviewExecutor['run']>();
  const second = await fixture(run, new SqliteAgentReviewStore(path));
  expect(second.reviews[0]?.files).toEqual(review.files);
  expect(second.reviews[0]?.dismissedIds).toEqual([review.findings[0]!.id]);
  expect(second.reviews[0]?.status).toBe(Status.COMPLETED);
  expect(run).not.toHaveBeenCalled();
});
it('recovers an unfinished checkpoint as interrupted without repeating inference', async () => {
  const createdAt = new Date().toISOString();
  const store = memoryStore([
    {
      ...input(),
      ...model,
      createdAt,
      updatedAt: createdAt,
      status: Status.RUNNING,
      findings: [],
      dismissedIds: [],
      summary: '',
    },
  ]);
  const run = vi.fn<AgentReviewExecutor['run']>();
  const service = await fixture(run, store);
  expect(service.reviews[0]?.status).toBe(Status.INTERRUPTED);
  expect((await store.load())[0]?.status).toBe(Status.INTERRUPTED);
  expect(run).not.toHaveBeenCalled();
});
it('cancels the exact review and ignores late completion', async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const service = await fixture(async (_, emit, cancellation) => {
    signal = cancellation;
    emit(report);
    await new Promise<void>(resolve => {
      finish = resolve;
    });
  });
  const request = input();
  await service.start(request, model);
  await vi.waitFor(() => expect(service.reviews[0]?.findings).toHaveLength(1));
  await service.cancel(request.id);
  expect(signal.aborted).toBe(true);
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(service.reviews[0]?.status).toBe(Status.CANCELLED);
});
it.each([
  'No issues found.',
  '<glyph_review>\n{"complete":true}',
  '<glyph_review>\n{"path":"outside.ts","line":1,"title":"x","body":"x"}\n{"complete":true}\n</glyph_review>',
])('fails incomplete or invalid output without presenting a clean review: %s', async text => {
  const service = await fixture(async (_, emit) => {
    emit(text);
  });
  await service.start(input(), model);
  await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.FAILED));
});
it('accepts an explicitly complete clean review', async () => {
  const service = await fixture(async (_, emit) => {
    emit('<glyph_review>\n{"complete":true}\n</glyph_review>');
  });
  await service.start(input(), model);
  await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));
  expect(service.reviews[0]?.findings).toEqual([]);
});
it('does not start inference when the initial checkpoint fails', async () => {
  const run = vi.fn<AgentReviewExecutor['run']>();
  const service = await fixture(run, {
    ...memoryStore(),
    save: async () => {
      throw new Error('disk full');
    },
  });
  await expect(service.start(input(), model)).rejects.toThrow('disk full');
  expect(run).not.toHaveBeenCalled();
  expect(service.reviews).toEqual([]);
});
it('validates capture paths and does not admit duplicate file identities', async () => {
  const run = vi.fn<AgentReviewExecutor['run']>();
  const service = await fixture(run);
  const request = input();
  await expect(
    service.start({ ...request, files: [{ ...request.files[0]!, path: '../private' }] }, model),
  ).rejects.toThrow();
  await expect(service.start({ ...request, files: [...request.files, ...request.files] }, model)).rejects.toThrow(
    'Duplicate',
  );
  expect(run).not.toHaveBeenCalled();
});
