import type { ShellAuthorizationContext } from './ShellAuthorizationContext.ts';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import { ShellPermissionDecision } from './ShellPermissionDecision.ts';
import { ShellPermissionMode, type ShellPermissionPolicy } from './ShellPermissionPolicy.ts';
import type { ShellPermissionPresenter } from './ShellPermissionPresenter.ts';
import type { ShellPermissionStore } from './ShellPermissionStore.ts';
import { ShellSandboxProfile } from './ShellSandboxProfile.ts';
import { isSafeShellCommand } from './isSafeShellCommand.ts';

/** Resolves exact-command authorization and persists project-scoped choices. */
export class ShellCommandAuthorizer {
  private policy: ShellPermissionPolicy;
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectContextId: string,
    private readonly store: ShellPermissionStore,
    private readonly presenter: ShellPermissionPresenter,
  ) {
    this.policy = emptyPolicy(projectContextId);
  }

  get mode(): ShellPermissionMode {
    return this.policy.mode;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.policy = (await this.store.load(this.projectContextId)) ?? emptyPolicy(this.projectContextId);
    this.initialized = true;
  }

  authorize(
    command: string,
    workingDirectory: string,
    signal: AbortSignal,
    context: ShellAuthorizationContext = { background: false, existingTerminal: false },
  ): Promise<ShellExecutionAuthorization> {
    return this.enqueue(async () => {
      await this.initialize();
      const normalized = normalizeCommand(command);
      if (this.policy.mode === ShellPermissionMode.ALLOW_EVERYTHING)
        return authorization(ShellSandboxProfile.FULL_ACCESS);
      if (
        this.policy.allowedCommands.some(
          grant => grant.command === normalized && grant.workingDirectory === workingDirectory,
        )
      )
        return authorization(ShellSandboxProfile.WORKSPACE_WRITE);
      if (
        this.policy.mode === ShellPermissionMode.ALLOW_SAFE &&
        !context.background &&
        !context.existingTerminal &&
        isSafeShellCommand(normalized)
      )
        return authorization(ShellSandboxProfile.READ_ONLY);
      const decision = await this.presenter.presentShellPermission({ command: normalized, workingDirectory }, signal);
      switch (decision) {
        case ShellPermissionDecision.ALLOW_ONCE:
          return authorization(ShellSandboxProfile.WORKSPACE_WRITE);
        case ShellPermissionDecision.ALWAYS_ALLOW:
          await this.persist({
            ...this.policy,
            allowedCommands: uniqueGrants([...this.policy.allowedCommands, { command: normalized, workingDirectory }]),
          });
          return authorization(ShellSandboxProfile.WORKSPACE_WRITE);
        case ShellPermissionDecision.ALLOW_SAFE:
          await this.persist({ ...this.policy, mode: ShellPermissionMode.ALLOW_SAFE });
          return authorization(
            !context.background && !context.existingTerminal && isSafeShellCommand(normalized)
              ? ShellSandboxProfile.READ_ONLY
              : ShellSandboxProfile.WORKSPACE_WRITE,
          );
        case ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE:
          return authorization(ShellSandboxProfile.FULL_ACCESS);
        case ShellPermissionDecision.ALLOW_EVERYTHING:
          await this.persist({ ...this.policy, mode: ShellPermissionMode.ALLOW_EVERYTHING });
          return authorization(ShellSandboxProfile.FULL_ACCESS);
        case ShellPermissionDecision.DENY:
          throw new Error('The user denied permission to execute this shell command.');
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async persist(policy: ShellPermissionPolicy): Promise<void> {
    await this.store.save(policy);
    this.policy = policy;
  }
}

function authorization(sandboxProfile: ShellSandboxProfile): ShellExecutionAuthorization {
  return { sandboxProfile };
}

function emptyPolicy(projectContextId: string): ShellPermissionPolicy {
  return {
    schemaVersion: 2,
    projectContextId,
    mode: ShellPermissionMode.ASK,
    allowedCommands: [],
  };
}

function uniqueGrants(grants: ShellPermissionPolicy['allowedCommands']): ShellPermissionPolicy['allowedCommands'] {
  return grants.filter(
    (grant, index) =>
      grants.findIndex(
        candidate => candidate.command === grant.command && candidate.workingDirectory === grant.workingDirectory,
      ) === index,
  );
}

function normalizeCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized) throw new Error('Shell command cannot be empty.');
  return normalized;
}
