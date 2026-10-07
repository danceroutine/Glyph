import type { ReactElement } from 'react';
import { ShellPermission } from './ShellPermission.presentational.tsx';
import type { TerminalShellPermissionRequest } from './ShellPermissionRequest.ts';
import { useShellPermissionState } from './useShellPermissionState.ts';

export interface WiredShellPermissionProps {
  readonly request: TerminalShellPermissionRequest;
  readonly active?: boolean;
}

export function WiredShellPermission({ request, active = true }: WiredShellPermissionProps): ReactElement {
  return <ShellPermission {...useShellPermissionState(request, active)} />;
}
