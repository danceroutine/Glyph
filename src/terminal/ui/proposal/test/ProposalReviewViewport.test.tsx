import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { WiredProposalReview } from '#src/terminal/ui/proposal/ProposalReview.wired.js';
import { createProposalReviewFixture } from './ProposalReviewFixture.ts';

const viewport = vi.hoisted(() => ({ columns: 50, rows: 24 }));
vi.mock('ink', async () => ({
  ...(await vi.importActual<typeof import('ink')>('ink')),
  useWindowSize: () => viewport,
}));

it.each([
  [40, false],
  [50, false],
  [80, true],
] as const)('keeps the last review line reachable at width %i with a diagnostic %s', async (columns, diagnostic) => {
  viewport.columns = columns;
  const fixture = createProposalReviewFixture();
  const file = fixture.proposal.files[0]!;
  const text = Array.from({ length: 80 }, (_, n) => `line ${n}`).join('\n');
  file.base = { ...file.base!, text };
  file.current = file.base;
  file.proposed = { ...file.proposed, text: `${text}\nFINAL_VISIBLE_LINE` };
  Object.assign(file.items[0]!, {
    sourceStart: text.length,
    sourceEnd: text.length,
    removedText: '',
    insertedText: '\nFINAL_VISIBLE_LINE',
  });
  fixture.accept.mockRejectedValue(
    new Error('A lengthy persistence diagnostic needs multiple terminal rows. '.repeat(4)),
  );
  const view = render(
    <Box width={columns} height={24} overflow="hidden">
      <WiredProposalReview request={{ id: 1, manager: fixture.manager, complete: vi.fn(), interrupt: vi.fn() }} />
    </Box>,
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (diagnostic) {
      view.stdin.write('y');
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Error:'));
    }
    view.stdin.write('f');
    await new Promise(resolve => setTimeout(resolve, 30));
    view.stdin.write('\u001b[F');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('FINAL_VISIBLE_LINE'));
    expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(24);
  } finally {
    view.unmount();
  }
});
