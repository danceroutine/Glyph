import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { Emitter } from '#vs/base/common/event.js';
import { TerminalExitReason, type ITerminalChildProcess } from '#vs/platform/terminal/common/terminal.js';
import type { ITerminalService } from '#vs/workbench/contrib/terminal/browser/terminal.js';
import type { GlyphBackgroundShell } from '#glyph/protocol/events/GlyphBackgroundShell.js';
import { GlyphShellTerminals } from '#vs/workbench/contrib/glyph/browser/GlyphShellTerminals.js';

const shellOf = (overrides: Partial<GlyphBackgroundShell> = {}): GlyphBackgroundShell => ({
  id: 'shell-1',
  chatId: 'chat-1',
  command: 'npm run dev',
  workingDirectory: '/repo',
  output: '',
  running: true,
  ...overrides,
});

interface FakeInstance {
  exitReason: TerminalExitReason | undefined;
  process: ITerminalChildProcess;
  onDisposed: Emitter<FakeInstance>['event'];
  focusWhenReady: Mock;
  dispose: Mock;
  close(reason: TerminalExitReason): void;
}

const terminalsOf = () => {
  const instances: FakeInstance[] = [];
  const createTerminal = vi.fn(
    async (options: {
      config: { customPtyImplementation: (id: number, cols: number, rows: number) => ITerminalChildProcess };
    }) => {
      const disposed = new Emitter<FakeInstance>();
      const instance: FakeInstance = {
        exitReason: undefined,
        process: options.config.customPtyImplementation(instances.length + 7, 80, 24),
        onDisposed: disposed.event,
        focusWhenReady: vi.fn(async () => {}),
        dispose: vi.fn(),
        close(reason) {
          instance.exitReason = reason;
          disposed.fire(instance);
        },
      };
      instances.push(instance);
      return instance;
    },
  );
  const service = {
    createTerminal,
    setActiveInstance: vi.fn(),
    revealActiveTerminal: vi.fn(async () => {}),
  };
  return { service, instances, terminals: service as unknown as ITerminalService };
};

const output = (process: ITerminalChildProcess) => {
  const data: string[] = [];
  process.onProcessData(event => data.push(typeof event === 'string' ? event : event.data));
  return data;
};

describe(GlyphShellTerminals, () => {
  describe(GlyphShellTerminals.prototype.open, () => {
    it('reveals a read-only terminal that mirrors the shell', async () => {
      const { service, instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });

      await viewers.open(shellOf({ command: `echo ${'x'.repeat(100)}` }));

      expect(service.createTerminal).toHaveBeenCalledWith({
        config: expect.objectContaining({
          name: `Glyph: echo ${'x'.repeat(75)}`,
          isFeatureTerminal: true,
          isTransient: true,
        }),
      });
      expect(instances[0].process.id).toBe(7);
      expect(instances[0].process.shouldPersist).toBe(false);
      expect(service.setActiveInstance).toHaveBeenCalledWith(instances[0]);
      expect(service.revealActiveTerminal).toHaveBeenCalled();
      expect(instances[0].focusWhenReady).toHaveBeenCalledWith(true);
    });

    it('reuses the terminal of a shell that is already open', async () => {
      const { service, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });

      await viewers.open(shellOf());
      await viewers.open(shellOf());

      expect(service.createTerminal).toHaveBeenCalledTimes(1);
      expect(service.setActiveInstance).toHaveBeenCalledTimes(2);
    });

    it('stops the shell only when the user closes its terminal', async () => {
      const { service, instances, terminals } = terminalsOf();
      const stop = vi.fn();
      const viewers = new GlyphShellTerminals(stop, terminals);
      onTestFinished(() => {
        viewers.dispose();
      });

      await viewers.open(shellOf());
      instances[0].close(TerminalExitReason.Shutdown);
      await viewers.open(shellOf());
      instances[1].close(TerminalExitReason.User);

      expect(service.createTerminal).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(shellOf());
    });

    it('forgets terminals that could not be created', async () => {
      const { service, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });
      const create = service.createTerminal.getMockImplementation()!;
      service.createTerminal.mockImplementationOnce(async () => {
        throw new Error('no terminal');
      });

      await expect(viewers.open(shellOf())).rejects.toThrow('no terminal');
      service.createTerminal.mockImplementation(create);
      await viewers.open(shellOf());

      expect(service.createTerminal).toHaveBeenCalledTimes(2);
    });
  });

  describe(GlyphShellTerminals.prototype.update, () => {
    it('streams appended output and reports how the shell finished', async () => {
      const { instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });
      await viewers.open(shellOf());
      const process = instances[0].process;
      const data = output(process);
      const ready = vi.fn();
      process.onProcessReady(ready);

      viewers.update([shellOf({ output: 'one\n' })]);
      await process.start();
      viewers.update([shellOf({ output: 'one\ntwo\n' })]);
      viewers.update([shellOf({ output: 'one\ntwo\n' })]);
      viewers.update([shellOf({ output: 'reset' })]);
      viewers.update([shellOf({ output: 'reset', running: false, exitCode: 0 })]);
      viewers.update([shellOf({ output: 'reset', running: false, exitCode: 0 })]);

      expect(ready).toHaveBeenCalledWith({ pid: -1, cwd: '/repo', windowsPty: undefined });
      expect(data).toEqual([
        'Agent terminals are read-only.\r\n',
        'one\r\n',
        'two\r\n',
        '',
        '\u001B[2J\u001B[Hreset',
        '',
        '\r\n[Exited (0)]\r\n',
        '',
      ]);
    });

    it('reports failed and exited shells without an exit code', async () => {
      const { instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });
      await viewers.open(shellOf());
      const process = instances[0].process;
      const data = output(process);

      await process.start();
      viewers.update([shellOf({ running: false, error: 'boom' })]);
      viewers.update([shellOf({ running: false })]);

      expect(data).toEqual([
        'Agent terminals are read-only.\r\n',
        '',
        '',
        '\r\n[Failed: boom]\r\n',
        '',
        '\r\n[Exited]\r\n',
      ]);
    });

    it('announces once that a shell has disappeared', async () => {
      const { instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });
      await viewers.open(shellOf());
      const process = instances[0].process;
      const data = output(process);

      await process.start();
      viewers.update([]);
      viewers.update([shellOf({ id: 'other' })]);

      expect(data).toEqual(['Agent terminals are read-only.\r\n', '', '\r\n[Terminal closed or disconnected]\r\n']);
    });

    it('starts silently for a shell that disappeared before its terminal started', async () => {
      const { instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      onTestFinished(() => {
        viewers.dispose();
      });
      await viewers.open(shellOf());
      const process = instances[0].process;
      const data = output(process);

      viewers.update([]);
      await process.start();

      expect(data).toEqual(['Agent terminals are read-only.\r\n']);
    });
  });

  describe(GlyphShellTerminals.prototype.dispose, () => {
    it('closes every terminal it opened, including ones still being created', async () => {
      const { service, instances, terminals } = terminalsOf();
      const viewers = new GlyphShellTerminals(vi.fn(), terminals);
      await viewers.open(shellOf());
      service.createTerminal.mockImplementationOnce(async () => {
        throw new Error('no terminal');
      });
      const failing = viewers.open(shellOf({ id: 'shell-2' }));

      viewers.dispose();

      await expect(failing).rejects.toThrow('no terminal');
      await vi.waitFor(() => {
        expect(instances[0].dispose).toHaveBeenCalled();
      });
    });
  });

  it('ignores input and exposes the shell working directory', async () => {
    const { instances, terminals } = terminalsOf();
    const viewers = new GlyphShellTerminals(vi.fn(), terminals);
    onTestFinished(() => {
      viewers.dispose();
    });
    await viewers.open(shellOf());
    const process = instances[0].process;
    const data = output(process);

    process.input('ls\r');
    process.sendSignal('SIGINT');
    process.resize(10, 10);
    await process.clearBuffer();
    process.acknowledgeDataEvent(1);
    await process.processBinary('x');
    await process.setUnicodeVersion('11');
    await process.updateProperty('title' as never, 'x' as never);
    process.onDidChangeProperty(vi.fn()).dispose();
    process.onProcessExit(vi.fn()).dispose();

    expect(data).toEqual([]);
    await expect(process.getInitialCwd()).resolves.toBe('/repo');
    await expect(process.getCwd()).resolves.toBe('/repo');
    await expect(process.refreshProperty('cwd' as never)).rejects.toThrow(
      'Read-only agent terminal does not expose property cwd.',
    );
    process.shutdown(false);
    viewers.update([shellOf({ output: 'late' })]);
    expect(data).toEqual([]);
  });
});
