import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';
import { ApprovalCapability } from './ApprovalCapability.ts';
import type { ApprovalGrant, ApprovalGrantStore, GrantPermission, GrantSnapshot } from './ApprovalGrant.ts';
import type { WorkspaceScope } from './ApprovalRequest.ts';

const scopeSchema = z.object({ workspaceId: z.string().min(1), mutationScope: z.string().min(1) }).strict();
const permissionSchema = z.union([
  z
    .object({
      capability: z.literal(ApprovalCapability.SHELL),
      kind: z.literal('exact_command'),
      command: z.string().min(1),
      workingDirectory: z.string().min(1),
    })
    .strict(),
  z
    .object({
      capability: z.literal(ApprovalCapability.SHELL),
      kind: z.enum(['safe_inspection', 'all_shell_commands']),
    })
    .strict(),
  z.object({ capability: z.literal(ApprovalCapability.INTERNAL_WEB), kind: z.literal('all_internal_web') }).strict(),
]);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    grants: z.array(
      z
        .object({
          id: z.string().min(1),
          workspace: scopeSchema,
          permission: permissionSchema,
          originatingDecisionId: z.string().min(1),
          createdAt: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
const legacyShell = z.discriminatedUnion('schemaVersion', [
  z
    .object({
      schemaVersion: z.literal(2),
      projectContextId: z.string().min(1),
      mode: z.enum(['ask', 'allow_safe', 'allow_everything']),
      allowedCommands: z.array(z.object({ command: z.string().min(1), workingDirectory: z.string().min(1) }).strict()),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      projectContextId: z.string().min(1),
      mode: z.enum(['ask', 'allow_safe', 'allow_everything']),
      allowedCommands: z.array(z.string().min(1)),
    })
    .strict(),
]);
const legacyWeb = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string(),
    capability: z.literal('internal_web'),
    allowEverything: z.literal(true),
  })
  .strict();
type ApprovalFiles = Pick<typeof fs, 'open' | 'mkdir' | 'rename' | 'unlink'>;
const maxBytes = 65_536;

/** Bounded, atomic grant snapshots with an exclusive cross-process update lock. */
export class FileApprovalStore implements ApprovalGrantStore {
  readonly kind = 'approval_grants';
  private readonly path: string;
  constructor(
    private readonly directory: string,
    private readonly files: ApprovalFiles = fs,
  ) {
    this.path = join(directory, 'approval-grants.json');
  }
  async load(scope: WorkspaceScope): Promise<GrantSnapshot> {
    const current = await this.read(this.path);
    if (current !== undefined) return { revision: digest(current), grants: schema.parse(JSON.parse(current)).grants };
    // Existing grants remain available until the first successful snapshot save.
    // Imports are scoped to the old canonical mutation identity, never just a path.
    const permissions: GrantPermission[] = [];
    const shell = await this.read(join(this.directory, 'shell-permissions.json'));
    if (shell !== undefined) {
      const policy = legacyShell.parse(JSON.parse(shell));
      if (policy.projectContextId === scope.mutationScope) {
        if (policy.mode === 'allow_everything')
          permissions.push({ capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' });
        for (const command of policy.schemaVersion === 2 ? policy.allowedCommands : [])
          permissions.push({ capability: ApprovalCapability.SHELL, kind: 'exact_command', ...command });
        if (policy.mode === 'allow_safe')
          permissions.push({ capability: ApprovalCapability.SHELL, kind: 'safe_inspection' });
      }
    }
    const web = await this.read(join(this.directory, 'internal-web-approvals.json'));
    if (web !== undefined && legacyWeb.parse(JSON.parse(web)).workspaceId === scope.mutationScope)
      permissions.push({ capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' });
    return {
      revision: digest(JSON.stringify([shell, web])),
      grants: permissions.map(permission => ({
        id: digest(JSON.stringify([scope, permission])),
        workspace: scope,
        permission,
        originatingDecisionId: 'legacy-import',
        createdAt: '1970-01-01T00:00:00.000Z',
      })),
    };
  }
  async save(
    scope: WorkspaceScope,
    expectedRevision: string,
    grants: readonly ApprovalGrant[],
  ): Promise<GrantSnapshot> {
    const bytes = JSON.stringify(schema.parse({ schemaVersion: 1, grants }));
    if (Buffer.byteLength(bytes) > maxBytes) throw new Error('Approval state exceeds its size limit.');
    await this.files.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    // A held or abandoned lock fails closed; never delete a lock we did not create.
    const lock = await this.files.open(lockPath, 'wx', 0o600);
    try {
      const current = await this.load(scope);
      if (current.revision !== expectedRevision) throw new Error('Approval grants changed; request a fresh decision.');
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const handle = await this.files.open(temporary, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        await this.files.rename(temporary, this.path);
      } finally {
        await this.files.unlink(temporary).catch(error => {
          if (errorCodeOf(error) !== 'ENOENT') throw error;
        });
      }
      return { revision: digest(bytes), grants: schema.parse(JSON.parse(bytes)).grants };
    } finally {
      try {
        await lock.close();
      } finally {
        await this.files.unlink(lockPath);
      }
    }
  }
  private async read(path: string): Promise<string | undefined> {
    let handle: fs.FileHandle;
    try {
      handle = await this.files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
        throw new Error('Approval state must be a small, uniquely linked regular file.');
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) throw new Error('Approval state exceeds its size limit.');
      return bytes.subarray(0, length).toString('utf8');
    } finally {
      await handle.close();
    }
  }
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
