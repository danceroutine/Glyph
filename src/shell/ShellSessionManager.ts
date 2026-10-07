import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import type { ShellCommandAuthorizer } from './ShellCommandAuthorizer.ts';
import type { ShellCommandResult } from './ShellCommandResult.ts';
import type { ShellSessionRegistry } from './ShellSessionRegistry.ts';
import type { ShellSessionSnapshot } from './ShellSessionSnapshot.ts';
import { ShellSandboxProfile } from './ShellSandboxProfile.ts';
import { ShellSessionStatus } from './ShellSessionStatus.ts';
import type { ShellWakeEvent } from './ShellWakeEvent.ts';
import type { ShellWorkingDirectoryResolver } from './ShellWorkingDirectoryResolver.ts';

const OUTPUT_TAIL_LIMIT = 64 * 1024;
const COMMAND_OUTPUT_LIMIT = 256 * 1024;
const TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_SESSIONS = 16;

interface RunningCommand {
  output: string;
  readonly sandboxProfile: ShellSandboxProfile;
  readonly resolve: (result: { output: string; exitCode: number }) => void;
  readonly reject: (error: Error) => void;
}

interface ExecuteShellCommandOptions {
  readonly terminalId?: string;
  readonly workingDirectory?: string;
  readonly background?: boolean;
  readonly wakeOn?: string;
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
  readonly ownerChatId?: string;
}

/** Owns authorized shell processes, output observation, wake events, and deterministic cleanup. */
export class ShellSessionManager implements ShellSessionRegistry {
  private readonly events = new EventEmitter();
  private readonly terminals = new Map<string, ManagedShellSession>();
  private readonly pendingWakes: ShellWakeEvent[] = [];
  private ownerChatId: string | undefined;
  private disposed = false;

  constructor(
    private readonly authorizer: ShellCommandAuthorizer,
    private readonly workingDirectories: ShellWorkingDirectoryResolver,
    private readonly processLauncher: ShellProcessLauncher,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly maxSessions = DEFAULT_MAX_SESSIONS,
  ) {}

  get sessions(): readonly ShellSessionSnapshot[] {
    return [...this.terminals.values()]
      .filter(terminal => terminal.snapshot.background && terminal.snapshot.ownerChatId === this.ownerChatId)
      .map(terminal => terminal.snapshot);
  }

  sessionsFor(ownerChatId: string): readonly ShellSessionSnapshot[] {
    return [...this.terminals.values()]
      .filter(terminal => terminal.snapshot.background && terminal.snapshot.ownerChatId === ownerChatId)
      .map(terminal => terminal.snapshot);
  }

  setOwnerChat(ownerChatId: string | undefined): void {
    this.ownerChatId = ownerChatId;
  }

  onDidChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  onDidWake(listener: (event: ShellWakeEvent) => void): () => void {
    this.events.on('wake', listener);
    return () => this.events.off('wake', listener);
  }

  takePendingWake(id?: string): ShellWakeEvent | undefined {
    if (id === undefined) return this.pendingWakes.shift();
    const index = this.pendingWakes.findIndex(event => event.id === id);
    if (index < 0) return undefined;
    return this.pendingWakes.splice(index, 1)[0];
  }

  async execute(command: string, options: ExecuteShellCommandOptions): Promise<ShellCommandResult> {
    options.signal.throwIfAborted();
    this.assertAvailable();
    const ownerChatId = options.ownerChatId ?? this.ownerChatId;
    const existing = options.terminalId ? this.requireTerminal(options.terminalId, ownerChatId) : undefined;
    if (!existing && this.terminals.size >= this.maxSessions) {
      throw new Error(`At most ${this.maxSessions} shell terminals may be active.`);
    }
    const workingDirectory = existing
      ? existing.snapshot.workingDirectory
      : await this.workingDirectories.resolve(options.workingDirectory);
    const authorization = await this.authorizer.authorize(command, workingDirectory, options.signal, {
      background: options.background === true,
      existingTerminal: existing !== undefined,
    });
    options.signal.throwIfAborted();
    this.assertAvailable();
    if (existing && this.terminals.get(existing.snapshot.id) !== existing) {
      throw new Error('The shell terminal was closed while permission was pending.');
    }
    if (!existing && this.terminals.size >= this.maxSessions) {
      throw new Error(`At most ${this.maxSessions} shell terminals may be active.`);
    }
    const terminal = existing ?? this.createTerminal(workingDirectory, options.background === true, ownerChatId);
    if (options.wakeOn !== undefined) terminal.setWakePattern(options.wakeOn);
    let completion: Promise<{ output: string; exitCode: number }>;
    try {
      completion = terminal.execute(command, authorization);
    } catch (error) {
      if (!existing) {
        this.terminals.delete(terminal.snapshot.id);
        this.changed();
      }
      throw error;
    }
    if (options.background) {
      void completion.catch(() => {
        // The terminal snapshot reports process failure; no caller is awaiting a background command.
      });
      terminal.setBackground(true);
      this.changed();
      return { terminalId: terminal.snapshot.id, status: 'backgrounded', output: terminal.snapshot.outputTail };
    }
    try {
      const result = await waitForCommand(completion, options.signal, options.timeoutMs);
      return { terminalId: terminal.snapshot.id, status: 'completed', ...result };
    } catch (error) {
      if (existing) await terminal.terminate();
      throw error;
    } finally {
      if (!existing) await this.close(terminal.snapshot.id, ownerChatId);
    }
  }

  writeInput(
    terminalId: string,
    input: string,
    appendNewline: boolean,
    wakeOn?: string,
    ownerChatId = this.ownerChatId,
  ): void {
    this.assertAvailable();
    const terminal = this.requireTerminal(terminalId, ownerChatId);
    if (wakeOn !== undefined) terminal.setWakePattern(wakeOn);
    terminal.writeInput(`${input}${appendNewline ? '\n' : ''}`);
  }

  async close(terminalId: string, ownerChatId = this.ownerChatId): Promise<void> {
    const terminal = this.requireTerminal(terminalId, ownerChatId);
    this.terminals.delete(terminalId);
    this.changed();
    await terminal.terminate();
  }

  shutdown(): void {
    for (const terminal of this.terminals.values()) void terminal.terminate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    this.changed();
    await Promise.all(terminals.map(terminal => terminal.terminate()));
    this.events.removeAllListeners();
  }

  private createTerminal(workingDirectory: string, background: boolean, ownerChatId?: string): ManagedShellSession {
    const id = this.createId();
    const terminal = new ManagedShellSession({
      id,
      workingDirectory,
      background,
      ...(ownerChatId ? { ownerChatId } : {}),
      startedAt: this.now().toISOString(),
      processLauncher: this.processLauncher,
      changed: () => this.changed(),
      wake: wake => {
        const event: ShellWakeEvent = {
          id: this.createId(),
          terminalId: id,
          ...(ownerChatId ? { ownerChatId } : {}),
          ...wake,
          matchedAt: this.now().toISOString(),
        };
        this.pendingWakes.push(event);
        this.events.emit('wake', event);
      },
    });
    this.terminals.set(id, terminal);
    this.changed();
    return terminal;
  }

  private requireTerminal(terminalId: string, ownerChatId: string | undefined): ManagedShellSession {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.snapshot.ownerChatId !== ownerChatId) {
      throw new Error(`Unknown shell terminal: ${terminalId}`);
    }
    return terminal;
  }

  private changed(): void {
    this.events.emit('change');
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('Shell session manager is closed.');
  }
}

interface ManagedShellSessionOptions {
  readonly id: string;
  readonly ownerChatId?: string;
  readonly workingDirectory: string;
  readonly background: boolean;
  readonly startedAt: string;
  readonly processLauncher: ShellProcessLauncher;
  readonly changed: () => void;
  readonly wake: (event: { pattern: string; command: string; workingDirectory: string; output: string }) => void;
}

class ManagedShellSession {
  private child: ChildProcess | undefined;
  private processExited: Promise<void> | undefined;
  private active: RunningCommand | undefined;
  private command = '';
  private status = ShellSessionStatus.IDLE;
  private background: boolean;
  private outputTail = '';
  private exitCode: number | undefined;
  private wakePattern: string | undefined;
  private wakeScanTail = '';

  constructor(private readonly options: ManagedShellSessionOptions) {
    this.background = options.background;
  }

  get snapshot(): ShellSessionSnapshot {
    return {
      id: this.options.id,
      ...(this.options.ownerChatId ? { ownerChatId: this.options.ownerChatId } : {}),
      workingDirectory: this.options.workingDirectory,
      command: this.command,
      status: this.status,
      background: this.background,
      outputTail: this.outputTail,
      startedAt: this.options.startedAt,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
      ...(this.wakePattern === undefined ? {} : { wakePattern: this.wakePattern }),
    };
  }

  setBackground(background: boolean): void {
    this.background = background;
  }

  setWakePattern(pattern: string): void {
    const normalized = pattern.trim();
    if (!normalized) throw new Error('Shell wake pattern cannot be empty.');
    this.wakePattern = normalized;
    this.wakeScanTail = '';
    this.options.changed();
  }

  execute(command: string, authorization: ShellExecutionAuthorization): Promise<{ output: string; exitCode: number }> {
    if (this.active) throw new Error('Shell terminal is busy. Use write_shell_input for interactive input.');
    const normalized = command.trim();
    if (!normalized) throw new Error('Shell command cannot be empty.');
    this.command = normalized;
    this.status = ShellSessionStatus.RUNNING;
    this.exitCode = undefined;
    let child: ChildProcess;
    try {
      child = this.options.processLauncher.launch(normalized, this.options.workingDirectory, authorization);
    } catch (error) {
      this.status = ShellSessionStatus.IDLE;
      this.options.changed();
      throw error;
    }
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdin!.on('error', () => {
      // Process exit is authoritative; a racing interactive write can observe EPIPE first.
    });
    child.stdout!.on('data', value => this.appendOutput(String(value)));
    child.stderr!.on('data', value => this.appendOutput(String(value)));
    this.options.changed();
    const completion = new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
      this.active = { output: '', sandboxProfile: authorization.sandboxProfile, resolve, reject };
      child.once('error', error => {
        if (this.child !== child) return;
        this.status = ShellSessionStatus.EXITED;
        this.child = undefined;
        this.active = undefined;
        reject(error);
        this.options.changed();
      });
    });
    child.once('exit', () => terminateProcessGroup(child.pid, 'SIGTERM'));
    this.processExited = new Promise(resolve => {
      child.once('close', (code, signal) => {
        if (this.child !== child) {
          resolve();
          return;
        }
        const active = this.active;
        this.exitCode = code ?? (signal ? 128 : 1);
        this.status = ShellSessionStatus.IDLE;
        this.child = undefined;
        this.active = undefined;
        active?.resolve({ output: active.output, exitCode: this.exitCode });
        this.options.changed();
        resolve();
      });
    });
    return completion;
  }

  writeInput(input: string): void {
    if (this.status !== ShellSessionStatus.RUNNING) {
      throw new Error(
        'Raw shell input is only allowed while a command is running. Use execute_shell for a new command.',
      );
    }
    if (this.active?.sandboxProfile === ShellSandboxProfile.FULL_ACCESS) {
      throw new Error(
        'Raw input to a full-access command is not authorized. Close it and use execute_shell so the complete command can be reviewed.',
      );
    }
    this.child?.stdin?.write(input);
  }

  async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    terminateProcess(child, 'SIGTERM');
    const timer = setTimeout(() => terminateProcess(child, 'SIGKILL'), TERMINATION_GRACE_MS);
    timer.unref();
    await this.processExited;
    clearTimeout(timer);
  }

  private appendOutput(value: string): void {
    if (this.active) this.active.output = tail(`${this.active.output}${value}`, COMMAND_OUTPUT_LIMIT);
    this.outputTail = tail(`${this.outputTail}${value}`, OUTPUT_TAIL_LIMIT);
    this.matchWake(value);
    this.options.changed();
  }

  private matchWake(value: string): void {
    const pattern = this.wakePattern;
    if (!pattern) return;
    const clean = stripVTControlCharacters(value);
    const candidate = `${this.wakeScanTail}${clean}`;
    if (candidate.includes(pattern)) {
      this.wakePattern = undefined;
      this.wakeScanTail = '';
      this.options.wake({
        pattern,
        command: this.command,
        workingDirectory: this.options.workingDirectory,
        output: stripVTControlCharacters(this.outputTail),
      });
      return;
    }
    this.wakeScanTail = tail(candidate, Math.max(0, pattern.length - 1));
  }
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminateProcessGroup(processId: number | undefined, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || processId === undefined) return;
  try {
    process.kill(-processId, signal);
  } catch {
    // The process group normally disappears with its foreground command.
  }
}

async function waitForCommand(
  completion: Promise<{ output: string; exitCode: number }>,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ output: string; exitCode: number }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  if (combined.aborted) throw combined.reason;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(combined.reason ?? new Error('Shell command cancelled.'));
    combined.addEventListener('abort', abort, { once: true });
    void completion.then(
      result => {
        combined.removeEventListener('abort', abort);
        resolve(result);
      },
      error => {
        combined.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import type { ShellProcessLauncher } from './ShellProcessLauncher.ts';
