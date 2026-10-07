import type { ReactElement } from 'react';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.ts';
import { BackgroundShells } from './BackgroundShells.presentational.tsx';

export interface WiredBackgroundShellsProps {
  readonly sessions: readonly ShellSessionSnapshot[];
}

export function WiredBackgroundShells({ sessions }: WiredBackgroundShellsProps): ReactElement | null {
  return <BackgroundShells sessions={sessions} />;
}
