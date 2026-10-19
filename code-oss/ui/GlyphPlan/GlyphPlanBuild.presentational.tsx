import { Button, ButtonVariant, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { SplitButton } from '#code-oss/ui/Button/SplitButton.tsx';
import { AgentModeID } from '#src/chat/AgentMode.js';
export function GlyphPlanBuild({
  build,
  buildNew,
  disabled,
}: {
  readonly build: () => void;
  readonly buildNew: () => void;
  readonly disabled: boolean;
}) {
  return (
    <SplitButton
      variant={ButtonVariant.PRIMARY}
      mode={AgentModeID.PLAN}
      size={ButtonSize.SMALL}
      disabled={disabled}
      onClick={build}
      shortcut="⌘↵"
      menuLabel="Build options"
      menu={
        <Button disabled={disabled} onClick={buildNew}>
          Build in new chat
        </Button>
      }
    >
      Build
    </SplitButton>
  );
}
