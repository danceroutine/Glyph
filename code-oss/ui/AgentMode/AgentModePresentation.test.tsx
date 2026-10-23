import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';
import { tokens } from '#code-oss/ui/design-system/index.ts';

afterEach(cleanup);

describe('AGENT_MODE_PRESENTATION', () => {
  it('renders an icon for every agent mode', () => {
    for (const mode of Object.values(AgentModeID)) {
      const { Icon } = AGENT_MODE_PRESENTATION[mode];
      const { container } = render(<Icon />);

      expect(container.querySelector('svg')).not.toBeNull();
      cleanup();
    }
  });

  it('gives plan mode the warning accent', () => {
    expect(AGENT_MODE_PRESENTATION[AgentModeID.PLAN].accent).toBe(tokens.text.warning);
    expect(AGENT_MODE_PRESENTATION[AgentModeID.PLAN].button.background).toBe(tokens.text.warning);
  });

  it('gives agent mode the standard button palette', () => {
    expect(AGENT_MODE_PRESENTATION[AgentModeID.AGENT].button.background).toBe(tokens.button.background);
    expect(AGENT_MODE_PRESENTATION[AgentModeID.AGENT].accent).toBe(tokens.text.muted);
  });

  it('cannot be reassigned', () => {
    expect(Object.isFrozen(AGENT_MODE_PRESENTATION)).toBe(true);
  });
});
