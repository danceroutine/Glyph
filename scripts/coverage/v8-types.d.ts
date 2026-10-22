declare module '@bcoe/v8-coverage' {
  import type { Profiler } from 'node:inspector';
  export function mergeProcessCovs(processes: { result: Profiler.ScriptCoverage[] }[]): {
    result: Profiler.ScriptCoverage[];
  };
}
