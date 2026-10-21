import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentReviewService } from '#src/reviewing/AgentReviewService.js';
import {
  AgentReviewScope,
  AgentReviewStatus as Status,
  type AgentReview,
  type AgentReviewInput,
} from '#src/reviewing/AgentReview.js';
import { SqliteAgentReviewStore } from '#src/reviewing/SqliteAgentReviewStore.js';
import type { AgentReviewExecutor } from '#src/reviewing/AgentReviewExecutor.js';
import type { AgentReviewStore } from '#src/reviewing/AgentReviewStore.js';
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
it('retains original-side findings beyond the modified EOF and persists both review sides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'glyph-review-sides-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'reviews.sqlite');
  const findings = [
    { ...finding, line: 4, side: 'original', title: 'Deleted validation' },
    { ...finding, line: 2, side: 'modified', title: 'Changed result' },
  ];
  const first = await fixture(async (_, emit) => {
    emit(
      `<glyph_review>\n${findings.map(value => JSON.stringify(value)).join('\n')}\n{"complete":true}\n</glyph_review>`,
    );
  }, new SqliteAgentReviewStore(path));
  const request = input();
  await first.start(
    {
      ...request,
      files: [{ ...request.files[0]!, before: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', after: 'one\ntwo' }],
    },
    model,
  );
  await vi.waitFor(() => expect(first.reviews[0]?.status).toBe(Status.COMPLETED));
  expect(first.reviews[0]?.findings).toMatchObject(findings);
  await first.dispose();
  const second = await fixture(vi.fn<AgentReviewExecutor['run']>(), new SqliteAgentReviewStore(path));
  expect(second.reviews[0]?.findings).toMatchObject(findings);
});
it.each([
  { side: 'original', line: 8 },
  { side: 'modified', line: 4 },
  { side: 'unknown', line: 1 },
])('rejects a finding outside its declared captured side: %j', async location => {
  const service = await fixture(async (_, emit) => {
    emit(`<glyph_review>\n${JSON.stringify({ ...finding, ...location })}\n{"complete":true}\n</glyph_review>`);
  });
  const request = input();
  await service.start(
    {
      ...request,
      files: [{ ...request.files[0]!, before: 'one\ntwo\nthree\nfour\nfive\nsix\nseven', after: 'one\ntwo' }],
    },
    model,
  );
  await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.FAILED));
  expect(service.reviews[0]?.findings).toEqual([]);
});
it('keeps reports without a side compatible with fully deleted files', async () => {
  const service = await fixture(async (_, emit) => {
    emit(`<glyph_review>\n${JSON.stringify({ ...finding, line: 4 })}\n{"complete":true}\n</glyph_review>`);
  });
  const request = input();
  await service.start(
    {
      ...request,
      files: [{ ...request.files[0]!, before: 'one\ntwo\nthree\nfour', after: '' }],
    },
    model,
  );
  await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));
  expect(service.reviews[0]?.findings).toMatchObject([{ line: 4, side: 'original' }]);
});

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

describe(AgentReviewService, () => {
  describe(AgentReviewService.prototype.onDidChange, () => {
    it('notifies subscribers of each change until they unsubscribe', async () => {
      const service = await fixture(async (_, emit) => {
        emit('<glyph_review>\n{"complete":true}\n</glyph_review>');
      });
      const listener = vi.fn();
      const unsubscribe = service.onDidChange(listener);
      await service.start(input(), model);
      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));

      expect(listener.mock.calls.map(([review]) => review.status)).toEqual([Status.RUNNING, Status.COMPLETED]);
      expect(unsubscribe()).toBe(true);
      await service.start(input(), model);
      await vi.waitFor(() => expect(service.reviews[1]?.status).toBe(Status.COMPLETED));
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe(AgentReviewService.prototype.start, () => {
    it('rejects reusing a review ID for a different capture', async () => {
      const service = await fixture(async (_, emit) => {
        emit('<glyph_review>\n{"complete":true}\n</glyph_review>');
      });
      const request = input();
      await service.start(request, model);

      await expect(
        service.start({ ...request, files: [{ ...request.files[0]!, after: 'const a = 2;\n' }] }, model),
      ).rejects.toThrow('Review ID already belongs to another capture.');
    });

    it('rejects new reviews after the service stops', async () => {
      const run = vi.fn<AgentReviewExecutor['run']>();
      const service = await fixture(run);
      await service.dispose();

      await expect(service.start(input(), model)).rejects.toThrow('Review service has stopped.');
      expect(run).not.toHaveBeenCalled();
    });

    it('fails a review whose output exceeds the size limit', async () => {
      const service = await fixture(async (_, emit) => {
        emit('x'.repeat(1024 * 1024 + 1));
      });
      await service.start(input(), model);

      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.FAILED));
      expect(service.reviews[0]?.error).toBe('Review output exceeded its limit.');
    });

    it('records non-error executor failures as text', async () => {
      const service = await fixture(async () => Promise.reject('provider offline'));
      await service.start(input(), model);

      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.FAILED));
      expect(service.reviews[0]?.error).toBe('provider offline');
    });

    it('publishes a failure that cannot be saved without persisting it', async () => {
      const saved: AgentReview[] = [];
      const store: AgentReviewStore = {
        load: async () => [],
        save: async review => {
          if (saved.length > 0) throw new Error('disk full');
          saved.push(structuredClone(review));
        },
        dispose: async () => {},
      };
      let signal!: AbortSignal;
      const service = await fixture(async (_, emit, cancellation) => {
        signal = cancellation;
        emit(`<glyph_review>\n${JSON.stringify(finding)}\n`);
        await new Promise<void>((_resolve, reject) =>
          cancellation.addEventListener('abort', () => reject(cancellation.reason), { once: true }),
        );
      }, store);
      const listener = vi.fn();
      service.onDidChange(listener);
      await service.start(input(), model);

      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.FAILED));
      expect(signal.aborted).toBe(true);
      expect(service.reviews[0]?.error).toBe(
        'Review results could not be saved. Check available storage before retrying.',
      );
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: Status.FAILED }));
      expect(saved.map(review => review.status)).toEqual([Status.RUNNING]);
    });

    it('ignores streamed findings that arrive after cancellation was requested', async () => {
      const store = memoryStore();
      const request = input();
      const service: AgentReviewService = await fixture(async (_, emit) => {
        void service.cancel(request.id);
        emit(report);
      }, store);
      await service.start(request, model);

      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.CANCELLED));
      await service.dispose();
      expect(service.reviews[0]?.findings).toEqual([]);
      expect((await store.load())[0]?.findings).toEqual([]);
    });

    it('keeps a cancelled status when the executor fails after cancellation', async () => {
      const service = await fixture(
        async (_, _emit, cancellation) =>
          new Promise<void>((_resolve, reject) =>
            cancellation.addEventListener('abort', () => reject(new Error('aborted run')), { once: true }),
          ),
      );
      const request = input();
      await service.start(request, model);
      await service.cancel(request.id);
      await service.dispose();

      expect(service.reviews[0]).toMatchObject({ status: Status.CANCELLED });
      expect(service.reviews[0]).not.toHaveProperty('error');
    });
  });

  describe(AgentReviewService.prototype.cancel, () => {
    it('leaves finished reviews unchanged', async () => {
      const service = await fixture(async (_, emit) => {
        emit('<glyph_review>\n{"complete":true}\n</glyph_review>');
      });
      const request = input();
      await service.start(request, model);
      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));
      const before = service.reviews[0];

      await service.cancel(request.id);

      expect(service.reviews[0]).toBe(before);
    });

    it('rejects unknown reviews', async () => {
      const service = await fixture(vi.fn<AgentReviewExecutor['run']>());

      await expect(service.cancel(randomUUID())).rejects.toThrow('The review is unavailable.');
    });
  });

  describe(AgentReviewService.prototype.dismiss, () => {
    it('rejects findings that are not part of the review', async () => {
      const service = await fixture(async (_, emit) => {
        emit(report);
      });
      const request = input();
      await service.start(request, model);
      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));

      await expect(service.dismiss(request.id, 'not-a-finding')).rejects.toThrow('The review finding is unavailable.');
    });

    it('dismisses a finding only once', async () => {
      const store = memoryStore();
      const save = vi.spyOn(store, 'save');
      const service = await fixture(async (_, emit) => {
        emit(report);
      }, store);
      const request = input();
      await service.start(request, model);
      await vi.waitFor(() => expect(service.reviews[0]?.status).toBe(Status.COMPLETED));
      const findingId = service.reviews[0]!.findings[0]!.id;
      await service.dismiss(request.id, findingId);
      const saves = save.mock.calls.length;

      await service.dismiss(request.id, findingId);

      expect(save).toHaveBeenCalledTimes(saves);
      expect(service.reviews[0]?.dismissedIds).toEqual([findingId]);
    });
  });

  describe(AgentReviewService.prototype.dispose, () => {
    it('interrupts a running review and waits for it to settle', async () => {
      const store = memoryStore();
      const dispose = vi.spyOn(store, 'dispose');
      let signal!: AbortSignal;
      const service = new AgentReviewService(store, {
        run: async (_, _emit, cancellation) => {
          signal = cancellation;
          await new Promise<void>((_resolve, reject) =>
            cancellation.addEventListener('abort', () => reject(cancellation.reason), { once: true }),
          );
        },
      });
      await service.initialize();
      const listener = vi.fn();
      service.onDidChange(listener);
      await service.start(input(), model);
      await vi.waitFor(() => expect(signal).toBeDefined());

      await service.dispose();

      expect(signal.aborted).toBe(true);
      expect(service.reviews[0]).toMatchObject({
        status: Status.INTERRUPTED,
        error: 'The review host stopped. Review again to retry.',
      });
      expect((await store.load())[0]?.status).toBe(Status.INTERRUPTED);
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('waits for a cancelled review that has not yet settled without changing its status', async () => {
      let finish!: () => void;
      const store = memoryStore();
      const service = new AgentReviewService(store, {
        run: async () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      });
      await service.initialize();
      const request = input();
      await service.start(request, model);
      await vi.waitFor(() => expect(finish).toBeDefined());
      await service.cancel(request.id);

      const disposed = service.dispose();
      finish();
      await disposed;

      expect(service.reviews[0]?.status).toBe(Status.CANCELLED);
      expect((await store.load())[0]?.status).toBe(Status.CANCELLED);
    });
  });
});
