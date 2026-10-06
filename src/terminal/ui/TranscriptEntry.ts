import type { ReactNode } from 'react';

/** Stable transcript content handed to Ink's non-redrawing Static region. */
export interface TranscriptEntry {
  id: number;
  content: ReactNode;
}
