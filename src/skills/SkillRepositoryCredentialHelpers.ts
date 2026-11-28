import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';

/**
 * Git asks for credentials on redirects, proxy negotiation and TLS authentication. Only Git and
 * libcurl know which of those paths the current transfer takes. A helper signals its own invocation
 * in the private per-command directory and waits for its program and inputs to join the child's lease.
 * The directory carries admission markers only. Credential bytes stay in Git's original helper pipe.
 */
export class SkillRepositoryCredentialHelpers {
  private readonly inputs = new Map<string, HostExecutionAuthority>();
  constructor(private readonly authority: HostExecutionAuthority) {}

  register(group: HostExecutionAuthority, command: string): string {
    const sleep = this.authority.executable('sleep').replaceAll("'", "'\\''");
    const id = String(this.inputs.size);
    this.inputs.set(id, group);
    // The bound also lets an orphaned helper exit if the host itself disappears.
    return (
      `!request="$GLYPH_GIT_CREDENTIAL_GATE/${id}"; ` +
      'test -n "$GLYPH_GIT_CREDENTIAL_GATE" && : >"$request" || { echo quit=true; exit 0; }; ' +
      'attempt=0; while ! test -f "$request.admitted"; do attempt=$((attempt + 1)); ' +
      `test "$attempt" -le 1200 && test -d "$GLYPH_GIT_CREDENTIAL_GATE" && '${sleep}' 0.05 || { echo quit=true; exit 0; }; done; ` +
      command.slice(1)
    );
  }

  async run<T>(
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    include: (inputs: HostExecutionAuthority) => Promise<void>,
    launch: (environment: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.inputs.size === 0) return launch(env, signal);
    const directory = join(cwd, 'glyph-credential-' + randomUUID());
    const storage = this.authority.inputs();
    storage.admit(directory);
    await include(storage);
    signal.throwIfAborted();
    await mkdir(directory, { mode: 0o700 });
    const stopped = new AbortController();
    const failed = new AbortController();
    const processSignal = AbortSignal.any([failed.signal, signal]);
    let serving: Promise<void> | undefined;
    try {
      const monitoring = AbortSignal.any([processSignal, stopped.signal]);
      serving = this.admitRequests(directory, include, monitoring).catch((error: unknown) => {
        if (!stopped.signal.aborted) failed.abort(error);
      });
      processSignal.throwIfAborted();
      const result = await launch({ ...env, GLYPH_GIT_CREDENTIAL_GATE: directory }, processSignal);
      processSignal.throwIfAborted();
      return result;
    } finally {
      stopped.abort();
      await serving;
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async admitRequests(
    directory: string,
    include: (inputs: HostExecutionAuthority) => Promise<void>,
    stopped: AbortSignal,
  ): Promise<void> {
    const remaining = new Map(this.inputs);
    while (remaining.size > 0) {
      for (const name of await readdir(directory)) {
        const group = remaining.get(name);
        if (group) {
          await include(group);
          stopped.throwIfAborted();
          await writeFile(join(directory, name + '.admitted'), '', { flag: 'wx', mode: 0o600 });
          remaining.delete(name);
        }
      }
      await setTimeout(25, undefined, { signal: stopped });
    }
  }
}
