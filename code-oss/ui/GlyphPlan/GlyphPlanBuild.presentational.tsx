import { Button, ButtonVariant, ButtonSize, ButtonLoadingPosition } from '#code-oss/ui/Button/Button.tsx';
import { SplitButton } from '#code-oss/ui/Button/SplitButton.tsx';
import { AgentModeID } from '#src/chat/AgentMode.js';
export function GlyphPlanBuild({
  build,
  buildNew,
  stop,
  disabled,
  building = false,
}: {
  readonly build: () => void;
  readonly buildNew: () => void;
  readonly stop?: (() => void) | undefined;
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
      menuDisabled={building ? !stop : disabled}
      menu={
        building ? (
          <Button disabled={!stop} onClick={stop}>
            Stop building
          </Button>
        ) : (
          <Button disabled={disabled} onClick={buildNew}>
            Build in new chat
          </Button>
        )
      }
    >
      {building ? 'Building' : 'Build'}
    </SplitButton>
  );
}
