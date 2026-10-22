import { Button, ButtonVariant, ButtonSize, ButtonLoadingPosition } from '#code-oss/ui/Button/Button.tsx';
import { SplitButton } from '#code-oss/ui/Button/SplitButton.tsx';
import { AgentModeID } from '#src/chat/AgentMode.js';
export function GlyphPlanBuild({
  build,
  buildNew,
  disabled,
  building = false,
}: {
  readonly build: () => void;
  readonly buildNew: () => void;
  readonly disabled: boolean;
  readonly building?: boolean;
}) {
  return (
    <SplitButton
      variant={ButtonVariant.PRIMARY}
      mode={AgentModeID.PLAN}
      size={ButtonSize.SMALL}
      disabled={disabled}
      loading={building}
      loadingPosition={ButtonLoadingPosition.TRAILING}
      onClick={build}
      {...(building ? {} : { shortcut: '⌘↵' })}
      menuLabel="Build options"
      menu={
        <Button disabled={disabled || building} onClick={buildNew}>
          Build in new chat
        </Button>
      }
    >
      {building ? 'Building' : 'Build'}
    </SplitButton>
  );
}
