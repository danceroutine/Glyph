import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { fn } from 'storybook/test';
import { modeSwapFixture } from '#code-oss/storybook/fixtures/InteractionFixtures.ts';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { useEffect, useState } from 'preact/hooks';
import type { GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { WiredGlyphAgentMessage } from './GlyphAgentMessage.wired.tsx';
import { agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';

function Example({
  autoApprove = false,
  status = GlyphModeSwapStatus.PENDING,
  target = AgentModeID.AGENT,
  disabled = false,
}: {
  autoApprove?: boolean;
  status?: GlyphModeSwap['status'];
  target?: GlyphModeSwap['target'];
  disabled?: boolean;
}) {
  const [swap, setSwap] = useState<GlyphModeSwap>(() => modeSwapFixture({ autoApprove, status, target }, Date.now()));
  useEffect(() => {
    if (swap.status !== GlyphModeSwapStatus.PENDING) return undefined;
    // Story-only host simulation. Production decisions come from DesktopInteractionBroker.
    const timer = setTimeout(
      () => {
        setSwap(current => ({
          ...current,
          status: current.autoApprove ? GlyphModeSwapStatus.APPROVED : GlyphModeSwapStatus.DENIED,
        }));
      },
      Math.max(0, Date.parse(swap.expiresAt) - Date.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [swap]);
  return (
    <WiredGlyphAgentMessage
      entry={agentMessageFixture({ text: 'Planning the next steps.', modeSwaps: [swap] })}
      chatId="chat"
      readOnly={disabled}
      actions={{
        ...previewActionsFixture(),
        decideApproval: fn<NonNullable<GlyphWorkbenchViewActions['decideApproval']>>(
          async (_chat, _run, _id, decision) => {
            setSwap(current => ({
              ...current,
              status:
                decision === GlyphApprovalDecision.ALLOW_ONCE
                  ? GlyphModeSwapStatus.APPROVED
                  : GlyphModeSwapStatus.DENIED,
            }));
          },
        ).mockName('GlyphAgentMessageModeSwap.decideApproval'),
      }}
    />
  );
}
const meta = {
  title: 'Glyph/Chat/In Transcript/Agent Message/Mode switch',
  component: Example,
  globals: { paneWidth: '600' },
  args: {},
  decorators: agentMessageDecorators,
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AwaitingApproval: Story = {};
export const AutoApprove: Story = { args: { autoApprove: true } };
export const SwitchedToAgent: Story = { args: { status: GlyphModeSwapStatus.APPROVED } };
export const SwitchedToPlan: Story = { args: { status: GlyphModeSwapStatus.APPROVED, target: AgentModeID.PLAN } };
export const Denied: Story = { args: { status: GlyphModeSwapStatus.DENIED } };
export const OtherWindow: Story = { args: { disabled: true } };
