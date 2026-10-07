import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditDecisionState } from '../../editing/reviews/EditDecisionState.ts';
import { EditFailureReason } from '../../editing/errors/EditFailureReason.ts';
import { EditOperation } from '../../editing/proposals/EditOperation.ts';
import { ProposalReviewManager } from '../../editing/reviews/ProposalReviewManager.ts';
import { FileProposalReviewStore } from '../../editing/reviews/persistence/FileProposalReviewStore.ts';
import { FileSystemWorkspaceTextStore } from '../../workspace/FileSystemWorkspaceTextStore.ts';
import { EditingE2EHarness } from './fixtures/EditingE2EHarness.ts';
import { ScriptedOpenAIResponsesFixture } from './fixtures/ScriptedOpenAIResponsesFixture.ts';
import { ToolInputKind } from '../../tools/ToolInputKind.ts';

let networkAttempts = 0;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts++;
    throw new Error('Network access is forbidden in editing E2E tests.');
  };
  for (const name of ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete process.env[name];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('staged editing loop', () => {
  it('runs a strict structured tool call through the real provider and applies mixed per-item decisions', async () => {
    const base = 'first\nmiddle\nlast\n';
    const revision = sha256(Buffer.from(base));
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-structured',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'a.txt',
            new_path: null,
            base_revision: revision,
            content: null,
            byte_order_mark: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                expected_text: 'first',
                replacement_text: 'FIRST',
              },
              {
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
                expected_text: 'last',
                replacement_text: 'LAST',
              },
            ],
          },
          {
            operation: EditOperation.CREATE,
            path: 'nested/new.txt',
            new_path: null,
            base_revision: null,
            content: 'created\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const harness = await EditingE2EHarness.create({ 'a.txt': base }, [
      {
        id: 'response-tools',
        output: [call],
        validate: request => {
          expect(request.parallel_tool_calls).toBe(false);
          const namespace = (
            request.tools as { type: string; tools: { type: string; name: string; strict?: boolean }[] }[]
          )[0]!;
          expect(namespace.tools.map(tool => [tool.type, tool.name])).toEqual([
            ['function', 'list_project_files'],
            ['function', 'read_project_file'],
            ['custom', 'propose_patch'],
            ['function', 'propose_edits'],
          ]);
          expect(namespace.tools.find(tool => tool.name === 'propose_edits')?.strict).toBe(true);
        },
      },
      { id: 'response-final', output: [EditingE2EHarness.finalMessage()] },
    ]);
    try {
      expect(await harness.send()).toBe('The edit is staged for your review.');
      const proposal = harness.reviews.active!;
      expect(await readFile(join(harness.projectRoot, 'a.txt'), 'utf8')).toBe(base);
      const [first, last] = proposal.files[0]!.items;
      const create = proposal.files[1]!.items[0]!;

      await harness.reviews.accept(last!.id);
      expect(await readFile(join(harness.projectRoot, 'a.txt'), 'utf8')).toBe('first\nmiddle\nLAST\n');
      await harness.reviews.reject(first!.id);
      await harness.reviews.accept(create.id);

      expect(await readFile(join(harness.projectRoot, 'a.txt'), 'utf8')).toBe('first\nmiddle\nLAST\n');
      expect(await readFile(join(harness.projectRoot, 'nested/new.txt'), 'utf8')).toBe('created\n');
      expect(proposal.files.flatMap(file => file.items).map(item => item.decision)).toEqual([
        EditDecisionState.REJECTED,
        EditDecisionState.ACCEPTED,
        EditDecisionState.ACCEPTED,
      ]);
      expect(harness.logger.entries.map(entry => entry.message)).toEqual(
        expect.arrayContaining([
          'editing.proposal.validated',
          'editing.review.staged',
          'editing.review.item.accepted',
          'editing.review.item.rejected',
          'editing.review.settled',
        ]),
      );
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('continues after mixed review decisions and restart with model context matching the workspace', async () => {
    const base = 'first\nmiddle\nlast\n';
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-review-result',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: sha256(Buffer.from(base)),
            content: null,
            byte_order_mark: null,
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                expected_text: 'first',
                replacement_text: 'FIRST',
              },
              {
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } },
                expected_text: 'last',
                replacement_text: 'LAST',
              },
            ],
          },
        ],
      },
    });
    let observedResult: {
      reviewId: string;
      items: { decision: string; affectedPaths: string[]; resultingRevision: string | null }[];
    } | null = null;
    const harness = await EditingE2EHarness.create({ 'file.txt': base }, [
      { id: 'response-review-tool', output: [call] },
      { id: 'response-review-final', output: [EditingE2EHarness.finalMessage()] },
      {
        id: 'response-after-restart',
        output: [EditingE2EHarness.finalMessage('The accepted change is present and the rejected change is absent.')],
        validate: request => {
          const developers = (request.input as { role?: string; content?: string }[]).filter(
            item => item.role === 'developer',
          );
          expect(developers).toHaveLength(2);
          const contexts = developers.map(
            item =>
              JSON.parse(item.content!) as {
                schema: string;
                event: { type: string; payload: NonNullable<typeof observedResult> };
              },
          );
          expect(contexts.every(context => context.schema === 'glyph.context-event.v1')).toBe(true);
          expect(contexts.every(context => context.event.type === 'edit_review_result')).toBe(true);
          observedResult = {
            reviewId: contexts[0]!.event.payload.reviewId,
            items: contexts.flatMap(context => context.event.payload.items),
          };
        },
      },
    ]);
    try {
      await harness.send('Change the first and last lines.');
      const proposal = harness.reviews.active!;
      const [first, last] = proposal.files[0]!.items;
      await harness.reviews.accept(first!.id);
      await harness.reviews.reject(last!.id);

      expect(harness.reviews.pendingResults).toHaveLength(2);
      await harness.commitReviewResults();
      harness.restartConversationFromCheckpoint();
      const response = await harness.send('Continue based on my review decisions.');

      expect(response).toBe('The accepted change is present and the rejected change is absent.');
      expect(await readFile(join(harness.projectRoot, 'file.txt'), 'utf8')).toBe('FIRST\nmiddle\nlast\n');
      expect(harness.reviews.activeReviews).toEqual([]);
      expect(harness.reviews.pendingResults).toEqual([]);
      expect(observedResult).toMatchObject({
        reviewId: proposal.id,
        items: [
          { decision: EditDecisionState.ACCEPTED, affectedPaths: ['file.txt'], resultingRevision: expect.any(String) },
          { decision: EditDecisionState.REJECTED, affectedPaths: ['file.txt'], resultingRevision: expect.any(String) },
        ],
      });
    } finally {
      await harness.dispose();
    }
  });

  it('appends proposals from successive actors to one durable review queue', async () => {
    const firstCall = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-first-actor',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'first.txt',
            new_path: null,
            base_revision: null,
            content: 'first actor\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const secondCall = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-second-actor',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.CREATE,
            path: 'second.txt',
            new_path: null,
            base_revision: null,
            content: 'second actor\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const harness = await EditingE2EHarness.create({}, [
      { id: 'response-first-tool', output: [firstCall] },
      { id: 'response-first-final', output: [EditingE2EHarness.finalMessage('First proposal staged.')] },
      { id: 'response-second-tool', output: [secondCall] },
      { id: 'response-second-final', output: [EditingE2EHarness.finalMessage('Second proposal staged.')] },
    ]);
    try {
      await harness.send('First actor request.');
      await harness.send('Second actor request.');

      const [first, second] = harness.reviews.activeReviews;
      expect(harness.reviews.activeReviews).toHaveLength(2);
      expect(first?.files[0]?.sourcePath).toBe('first.txt');
      expect(second?.files[0]?.sourcePath).toBe('second.txt');
      await expect(readFile(join(harness.projectRoot, 'first.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(harness.projectRoot, 'second.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

      await harness.reviews.acceptInReview(first!.id, first!.files[0]!.items[0]!.id);
      expect(harness.reviews.activeReviews).toEqual([second]);
      await harness.reviews.acceptInReview(second!.id, second!.files[0]!.items[0]!.id);

      expect(await readFile(join(harness.projectRoot, 'first.txt'), 'utf8')).toBe('first actor\n');
      expect(await readFile(join(harness.projectRoot, 'second.txt'), 'utf8')).toBe('second actor\n');
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('preserves exact bytes across the structured text, boundary, whitespace, and Unicode matrix', async () => {
    const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
    const cases = [
      editCase('insert-begin.txt', 'bc', 'abc', [{ line: 0, character: 0, expected: '', replacement: 'a' }]),
      editCase('insert-middle.txt', 'ac', 'abc', [{ line: 0, character: 1, expected: '', replacement: 'b' }]),
      editCase('insert-eof.txt', 'ab', 'abc', [{ line: 0, character: 2, expected: '', replacement: 'c' }]),
      editCase('delete-first.txt', 'first\nmiddle\nlast\n', 'middle\nlast\n', [
        { line: 0, character: 0, endLine: 1, endCharacter: 0, expected: 'first\n', replacement: '' },
      ]),
      editCase('delete-interior.txt', 'first\nmiddle\nlast\n', 'first\nlast\n', [
        { line: 1, character: 0, endLine: 2, endCharacter: 0, expected: 'middle\n', replacement: '' },
      ]),
      editCase('delete-last.txt', 'first\nmiddle\nlast\n', 'first\nmiddle\n', [
        { line: 2, character: 0, endLine: 3, endCharacter: 0, expected: 'last\n', replacement: '' },
      ]),
      editCase('delete-entire.txt', 'first\nmiddle\nlast\n', '', [
        { line: 0, character: 0, endLine: 3, endCharacter: 0, expected: 'first\nmiddle\nlast\n', replacement: '' },
      ]),
      editCase('replace-same.txt', 'cat', 'dog', [
        { line: 0, character: 0, endCharacter: 3, expected: 'cat', replacement: 'dog' },
      ]),
      editCase('replace-short.txt', 'longer', 'x', [
        { line: 0, character: 0, endCharacter: 6, expected: 'longer', replacement: 'x' },
      ]),
      editCase('replace-long.txt', 'x', 'longer', [
        { line: 0, character: 0, endCharacter: 1, expected: 'x', replacement: 'longer' },
      ]),
      editCase('empty.txt', '', '🧪', [{ line: 0, character: 0, expected: '', replacement: '🧪' }]),
      editCase('remove-final-newline.txt', 'line\n', 'line', [
        { line: 0, character: 4, endLine: 1, endCharacter: 0, expected: '\n', replacement: '' },
      ]),
      editCase('add-final-newline.txt', 'line', 'line\n', [{ line: 0, character: 4, expected: '', replacement: '\n' }]),
      editCase('crlf.txt', 'a\r\nb\r\n', 'a\r\nB\r\n', [
        { line: 1, character: 0, endCharacter: 1, expected: 'b', replacement: 'B' },
      ]),
      editCase('mixed.txt', 'a\r\nb\nc\r', 'A\r\nb\nc\r', [
        { line: 0, character: 0, endCharacter: 1, expected: 'a', replacement: 'A' },
      ]),
      editCase('whitespace.txt', '\tvalue  \n', '  value\t \n', [
        { line: 0, character: 0, endCharacter: 8, expected: '\tvalue  ', replacement: '  value\t ' },
      ]),
      editCase('accented.txt', 'café', 'CAFÉ', [
        { line: 0, character: 0, endCharacter: 4, expected: 'café', replacement: 'CAFÉ' },
      ]),
      editCase('emoji.txt', 'a😀b', 'a🧪b', [
        { line: 0, character: 1, endCharacter: 3, expected: '😀', replacement: '🧪' },
      ]),
      editCase('combining.txt', 'é', 'è', [{ line: 0, character: 1, endCharacter: 2, expected: '́', replacement: '̀' }]),
      editCase('non-latin.txt', '日本語', '日本語です', [{ line: 0, character: 3, expected: '', replacement: 'です' }]),
      editCase('touching.txt', 'abcd', 'ABcd', [
        { line: 0, character: 0, endCharacter: 1, expected: 'a', replacement: 'A' },
        { line: 0, character: 1, endCharacter: 2, expected: 'b', replacement: 'B' },
      ]),
      editCase('repeated.txt', 'same\nsame\n', 'same\nchanged\n', [
        { line: 1, character: 0, endCharacter: 4, expected: 'same', replacement: 'changed' },
      ]),
      editCase('long-line.txt', 'x'.repeat(16_384), `${'x'.repeat(16_384)}!`, [
        { line: 0, character: 16_384, expected: '', replacement: '!' },
      ]),
      editCase(
        'byteOrderMark.txt',
        Buffer.concat([byteOrderMark, Buffer.from('old\n')]),
        Buffer.concat([byteOrderMark, Buffer.from('new\n')]),
        [{ line: 0, character: 0, endCharacter: 3, expected: 'old', replacement: 'new' }],
      ),
    ];
    const files = Object.fromEntries(cases.map(entry => [entry.path, entry.initial]));
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-matrix',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: { files: cases.map(entry => entry.input) },
    });
    const harness = await EditingE2EHarness.create(files, [
      { id: 'response-matrix', output: [call] },
      { id: 'response-matrix-final', output: [EditingE2EHarness.finalMessage()] },
    ]);
    try {
      await harness.send();
      await harness.reviews.acceptAll();
      for (const entry of cases)
        expect(await readFile(join(harness.projectRoot, entry.path)), entry.path).toEqual(Buffer.from(entry.expected));
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('runs a free-form custom patch call, preserves carriage-return line-feed endings and the byte order mark, and validates custom output continuation', async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree\r\n')]);
    const revision = sha256(raw);
    const patch = `*** Begin Patch\n*** Update File: file.txt\n*** Revision: ${revision}\n*** Byte Order Mark: true\n*** Line Ending: CRLF\n@@\n one\n-two\n+TWO\n three\n*** End Patch`;
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-patch',
      namespace: 'project',
      name: 'propose_patch',
      inputKind: ToolInputKind.TEXT,
      input: patch,
    });
    const harness = await EditingE2EHarness.create({ 'file.txt': raw }, [
      { id: 'response-patch', output: [call] },
      { id: 'response-final', output: [EditingE2EHarness.finalMessage()] },
    ]);
    try {
      await harness.send();
      await harness.reviews.acceptAll();
      expect(await readFile(join(harness.projectRoot, 'file.txt'))).toEqual(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\nTWO\r\nthree\r\n')]),
      );
      const continuation = harness.fixture.requests[1]!.input as { type?: string; call_id?: string }[];
      expect(continuation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'custom_tool_call', call_id: 'call-patch' }),
          expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'call-patch' }),
        ]),
      );
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('retains a staged proposal across final-model failure, restart, and same-file collaborator staleness', async () => {
    const base = 'base\n';
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-failure',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: sha256(Buffer.from(base)),
            content: 'agent\n',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const harness = await EditingE2EHarness.create({ 'file.txt': base, 'unrelated.txt': 'keep\n' }, [
      { id: 'response-stage', output: [call] },
      {
        id: 'response-failure',
        status: 'failed',
        error: { code: 'fixture', message: 'model failed after staging' },
        output: [],
      },
    ]);
    try {
      await expect(harness.send()).rejects.toThrow(/model failed after staging/);
      expect(harness.reviews.active).toBeDefined();
      await writeFile(join(harness.projectRoot, 'file.txt'), 'collaborator\n');
      await writeFile(join(harness.projectRoot, 'unrelated.txt'), 'collaborator unrelated\n');
      const recovered = new ProposalReviewManager(
        new FileSystemWorkspaceTextStore(harness.projectRoot),
        new FileProposalReviewStore(harness.stateRoot),
        harness.logger,
      );
      await recovered.initialize();
      expect(recovered.active?.files[0]?.applicability).toBe('STALE');
      await expect(recovered.acceptAll()).rejects.toMatchObject({ reason: EditFailureReason.STALE });
      expect(await readFile(join(harness.projectRoot, 'file.txt'), 'utf8')).toBe('collaborator\n');
      expect(await readFile(join(harness.projectRoot, 'unrelated.txt'), 'utf8')).toBe('collaborator unrelated\n');
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('retains a staged proposal when the final model round is cancelled', async () => {
    const base = 'base';
    const controller = new AbortController();
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-cancel',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: sha256(Buffer.from(base)),
            content: 'changed',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const harness = await EditingE2EHarness.create({ 'file.txt': base }, [
      { id: 'response-stage-cancel', output: [call] },
      {
        id: 'response-cancelled',
        status: 'cancelled',
        output: [],
        validate: () => setImmediate(() => controller.abort()),
      },
    ]);
    try {
      await expect(harness.sendWithSignal(controller.signal)).rejects.toThrow(/cancelled/i);
      expect(harness.reviews.active?.files[0]?.items[0]?.decision).toBe(EditDecisionState.PENDING);
      expect(await readFile(join(harness.projectRoot, 'file.txt'), 'utf8')).toBe(base);
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it('serializes concurrent opposing decisions so exactly one wins and the other is typed', async () => {
    const base = 'base';
    const call = ScriptedOpenAIResponsesFixture.encodeToolCall({
      callId: 'call-race',
      namespace: 'project',
      name: 'propose_edits',
      inputKind: ToolInputKind.JSON,
      input: {
        files: [
          {
            operation: EditOperation.UPDATE,
            path: 'file.txt',
            new_path: null,
            base_revision: sha256(Buffer.from(base)),
            content: 'changed',
            byte_order_mark: null,
            edits: [],
          },
        ],
      },
    });
    const harness = await EditingE2EHarness.create({ 'file.txt': base }, [
      { id: 'response-race', output: [call] },
      { id: 'response-final', output: [EditingE2EHarness.finalMessage()] },
    ]);
    try {
      await harness.send();
      const item = harness.reviews.active!.files[0]!.items[0]!;
      const results = await Promise.allSettled([harness.reviews.accept(item.id), harness.reviews.reject(item.id)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ reason: EditFailureReason.DECISION_CONFLICT });
      expect(networkAttempts).toBe(0);
    } finally {
      await harness.dispose();
    }
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface MatrixEdit {
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
  expected: string;
  replacement: string;
}

function editCase(path: string, initial: string | Uint8Array, expected: string | Uint8Array, edits: MatrixEdit[]) {
  const bytes = typeof initial === 'string' ? Buffer.from(initial) : Buffer.from(initial);
  return {
    path,
    initial,
    expected,
    input: {
      operation: EditOperation.UPDATE,
      path,
      new_path: null,
      base_revision: sha256(bytes),
      content: null,
      byte_order_mark: null,
      edits: edits.map(edit => ({
        range: {
          start: { line: edit.line, character: edit.character },
          end: { line: edit.endLine ?? edit.line, character: edit.endCharacter ?? edit.character },
        },
        expected_text: edit.expected,
        replacement_text: edit.replacement,
      })),
    },
  };
}
