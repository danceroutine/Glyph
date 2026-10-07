import { describe, expect, it, vi } from 'vitest';
import type { EditProposalService } from '../../editing/proposals/EditProposalService.ts';
import type { EditProposal } from '../../editing/proposals/EditProposal.ts';
import type { ProposalReviewManager } from '../../editing/reviews/ProposalReviewManager.ts';
import { NullLogger } from '../../observability/NullLogger.ts';
import type { ProjectAccess } from '../ProjectAccess.ts';
import { ProjectToolName } from '../ProjectToolName.ts';
import { ProjectToolRuntime } from '../ProjectToolRuntime.ts';

describe(ProjectToolRuntime, () => {
  describe(ProjectToolRuntime.prototype.execute, () => {
    it('captures host-owned chat provenance when staging a proposal', async () => {
      const proposal: EditProposal = {
        schemaVersion: 1,
        id: 'proposal-1',
        source: 'patch',
        createdAt: new Date(0).toISOString(),
        files: [],
      };
      const activeReviews: EditProposal[] = [];
      const stage = vi.fn(async (staged: EditProposal) => {
        activeReviews.push(staged);
      });
      const runtime = new ProjectToolRuntime(
        { definitions: [] } as unknown as ProjectAccess,
        { proposePatch: vi.fn(async () => proposal) } as unknown as EditProposalService,
        { stage, activeReviews } as unknown as ProposalReviewManager,
        new NullLogger(),
      );

      await runtime.execute(ProjectToolName.PROPOSE_PATCH, 'patch', undefined, {
        chat: { id: 'chat-1', accountProvider: 'provider', accountId: 'account-1' },
      });

      expect(stage).toHaveBeenCalledWith({
        ...proposal,
        origin: { chatId: 'chat-1', accountProvider: 'provider', accountId: 'account-1' },
      });
    });
  });
});
