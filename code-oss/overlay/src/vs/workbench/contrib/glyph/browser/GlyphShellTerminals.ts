import { Emitter, Event } from '#vs/base/common/event.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { ITerminalService, type ITerminalInstance } from '#vs/workbench/contrib/terminal/browser/terminal.js';
import { TerminalExitReason } from '#vs/platform/terminal/common/terminal.js';
import type {
  ITerminalChildProcess,
  IProcessReadyEvent,
  IProcessPropertyMap,
  ProcessPropertyType,
} from '#vs/platform/terminal/common/terminal.js';
import type { GlyphBackgroundShell } from '#glyph/protocol/events/GlyphBackgroundShell.js';

/** Native terminal viewers mirror host output; no second shell or input channel is created. */
export class GlyphShellTerminals extends Disposable {
  private readonly viewers = new Map<string, { process: GlyphShellOutput; terminal: Promise<ITerminalInstance> }>();

  constructor(
    private readonly stop: (shell: GlyphBackgroundShell) => void,
    @ITerminalService private readonly terminals: ITerminalService,
  ) {
    super();
  }

  async open(shell: GlyphBackgroundShell): Promise<void> {
    let viewer = this.viewers.get(shell.id);
    if (!viewer) {
      const process = new GlyphShellOutput(shell);
      const terminal = this.terminals.createTerminal({
        config: {
          name: `Glyph: ${shell.command.slice(0, 80)}`,
          isFeatureTerminal: true,
          isTransient: true,
          customPtyImplementation: id => {
            process.id = id;
            return process;
          },
        },
      });
      viewer = { process, terminal };
      this.viewers.set(shell.id, viewer);
      void terminal.then(
        instance => {
          this._register(
            instance.onDisposed(() => {
              this.viewers.delete(shell.id);
              if (instance.exitReason === TerminalExitReason.User) this.stop(shell);
              process.dispose();
            }),
          );
        },
        () => {
          this.viewers.delete(shell.id);
          process.dispose();
        },
      );
    }
    const instance = await viewer.terminal;
    this.terminals.setActiveInstance(instance);
    await this.terminals.revealActiveTerminal();
    await instance.focusWhenReady(true);
  }

  update(shells: readonly GlyphBackgroundShell[]): void {
    for (const [id, viewer] of this.viewers) viewer.process.update(shells.find(shell => shell.id === id));
  }

  override dispose(): void {
    for (const viewer of this.viewers.values()) {
      viewer.process.dispose();
      void viewer.terminal.then(
        terminal => terminal.dispose(),
        () => {},
      );
    }
    this.viewers.clear();
    super.dispose();
  }
}

/** Intentionally ignores all terminal input; process ownership stays in the desktop host. */
class GlyphShellOutput extends Disposable implements ITerminalChildProcess {
  id = 0;
  readonly shouldPersist = false;
  private readonly data = this._register(new Emitter<string>());
  readonly onProcessData = this.data.event;
  private readonly ready = this._register(new Emitter<IProcessReadyEvent>());
  readonly onProcessReady = this.ready.event;
  readonly onDidChangeProperty = Event.None;
  readonly onProcessExit = Event.None;
  private started = false;
  private output = '';
  private status = '';
  constructor(private shell: GlyphBackgroundShell) {
    super();
  }
  async start() {
    this.started = true;
    this.ready.fire({ pid: -1, cwd: this.shell.workingDirectory, windowsPty: undefined });
    this.data.fire('Agent terminals are read-only.\r\n');
    this.update(this.status === 'closed' ? undefined : this.shell);
    return undefined;
  }
  update(shell: GlyphBackgroundShell | undefined): void {
    if (!shell) {
      if (this.started && this.status !== 'closed') this.data.fire('\r\n[Terminal closed or disconnected]\r\n');
      this.status = 'closed';
      return;
    }
    this.shell = shell;
    if (!this.started) return;
    const output = shell.output.replace(/\r?\n/g, '\r\n');
    if (output.startsWith(this.output)) this.data.fire(output.slice(this.output.length));
    else if (output !== this.output) this.data.fire(`\x1b[2J\x1b[H${output}`);
    this.output = output;
    const status = shell.running
      ? 'running'
      : shell.error
        ? `Failed: ${shell.error}`
        : `Exited${shell.exitCode === undefined ? '' : ` (${shell.exitCode})`}`;
    if (status !== this.status && !shell.running) this.data.fire(`\r\n[${status}]\r\n`);
    this.status = status;
  }
  shutdown(): void {
    this.dispose();
  }
  input(): void {}
  sendSignal(): void {}
  async processBinary(): Promise<void> {}
  resize(): void {}
  clearBuffer(): void {}
  acknowledgeDataEvent(): void {}
  async setUnicodeVersion(): Promise<void> {}
  async getInitialCwd(): Promise<string> {
    return this.shell.workingDirectory;
  }
  async getCwd(): Promise<string> {
    return this.shell.workingDirectory;
  }
  async refreshProperty<T extends ProcessPropertyType>(property: T): Promise<IProcessPropertyMap[T]> {
    throw new Error(`Read-only agent terminal does not expose property ${property}.`);
  }
  async updateProperty(): Promise<void> {}
}
