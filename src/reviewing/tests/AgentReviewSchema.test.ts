import { describe, expect, it } from 'vitest';
import { AgentReviewScope, AgentReviewStatus } from '#src/reviewing/AgentReview.js';
import { agentReviewInputSchema, agentReviewSchema } from '#src/reviewing/AgentReviewSchema.js';

describe('agentReviewInputSchema', () => {
  it('rejects captures larger than six mebibytes in total', () => {
    const large = 'x'.repeat(2 * 1024 * 1024);
    const file = (path: string) => ({
      path,
      uri: `file:///workspace/${path}`,
      before: large,
      after: large,
      contextText: '',
      revision: 'r',
    });

    const result = agentReviewInputSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000000',
      repositoryUri: 'file:///workspace',
      scope: AgentReviewScope.ALL_LOCAL,
      branch: '',
      label: 'All local changes',
      files: [file('a.ts'), file('b.ts')],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(issue => issue.message)).toEqual(['The captured review exceeds its size limit.']);
  });
});

describe('agentReviewSchema', () => {
  it('omits absent finding sides and keeps recorded errors', () => {
    const createdAt = new Date().toISOString();

    const review = agentReviewSchema.parse({
      id: '00000000-0000-4000-8000-000000000000',
      repositoryUri: 'file:///workspace',
      scope: AgentReviewScope.BRANCH,
      branch: 'main',
      label: 'Branch',
      files: [
        { path: 'file.ts', uri: 'file:///workspace/file.ts', before: '', after: 'x', contextText: '', revision: 'r' },
      ],
      accountProvider: 'fixture',
      accountId: 'account',
      model: 'test-model',
      status: AgentReviewStatus.FAILED,
      createdAt,
      updatedAt: createdAt,
      findings: [{ id: 'file.ts:1:0', path: 'file.ts', line: 1, title: 'Bug', body: 'Breaks.' }],
      dismissedIds: [],
      summary: '',
      error: 'The model failed.',
    });

    expect(review.findings).toEqual([{ id: 'file.ts:1:0', path: 'file.ts', line: 1, title: 'Bug', body: 'Breaks.' }]);
    expect(review.findings[0]).not.toHaveProperty('side');
    expect(review.error).toBe('The model failed.');
  });
});
