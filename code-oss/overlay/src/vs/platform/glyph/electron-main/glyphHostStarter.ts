import { resolve } from 'node:path';
import { GlyphTransportMessageType } from '#glyph/protocol/connection/GlyphTransportMessage.js';
import type { IpcMainEvent, WebContents } from 'electron';
import { generateUuid } from '#vs/base/common/uuid.js';
import { Disposable, toDisposable } from '#vs/base/common/lifecycle.js';
import { validatedIpcMain } from '#vs/base/parts/ipc/electron-main/ipcMain.js';
import { IEnvironmentMainService } from '#vs/platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '#vs/platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '#vs/platform/log/common/log.js';
import { NullTelemetryService } from '#vs/platform/telemetry/common/telemetryUtils.js';
import { UtilityProcess } from '#vs/platform/utilityProcess/electron-main/utilityProcess.js';
import { IWindowsMainService } from '#vs/platform/windows/electron-main/windows.js';

const requestChannel = 'vscode:glyph:createHostMessageChannel';
const responseChannel = 'vscode:glyph:createHostMessageChannelResult';

/**
 * Lazily owns the single Glyph utility process and brokers one MessagePort per
 * Code OSS window. Deriving identity in Electron main prevents a compromised
 * renderer from impersonating another profile, workspace, or window.
 */
export class GlyphHostStarter extends Disposable {
  /** Shared process keeps workspace/runtime state alive across renderer reloads. */
  private utilityProcess: UtilityProcess | undefined;
  /** Tracked senders receive an explicit host-exit signal instead of hanging requests. */
  private readonly senders = new Map<number, WebContents>();

  constructor(
    @IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
    @ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
    @ILogService private readonly logService: ILogService,
    @IWindowsMainService private readonly windowsMainService: IWindowsMainService,
  ) {
    super();
    const listener = (event: IpcMainEvent, nonce: unknown) => void this.connectWindow(event, nonce);
    validatedIpcMain.on(requestChannel, listener);
    this._register(toDisposable(() => validatedIpcMain.removeListener(requestChannel, listener)));
    this._register(
      toDisposable(() => {
        this.utilityProcess?.kill();
        this.utilityProcess?.dispose();
        this.utilityProcess = undefined;
      }),
    );
  }

  /** Validates the IPC sender before transferring a newly authenticated port. */
  private async connectWindow(event: IpcMainEvent, nonce: unknown): Promise<void> {
    if (typeof nonce !== 'string' || event.sender.isDestroyed()) return;
    const window = this.windowsMainService.getWindowByWebContents(event.sender);
    if (!window) return this.fail(event.sender, nonce, 'The requesting Glyph window is not registered.');
    const workspaceId = window.openedWorkspace?.id ?? `empty:${window.id}`;
    const identity = {
      profileId: window.profile?.id ?? 'default',
      windowId: String(window.id),
      workspaceId,
    };
    try {
      this.logService.info(
        `[Glyph host] connection requested (profile=${identity.profileId}, window=${identity.windowId}, workspace=${identity.workspaceId})`,
      );
      const process = this.start();
      const connectionId = generateUuid();
      const port = process.connect({ type: GlyphTransportMessageType.CONNECTION, connectionId, identity });
      if (event.sender.isDestroyed()) return port.close();
      this.track(event.sender);
      event.sender.postMessage(responseChannel, nonce, [port]);
    } catch (error) {
      this.fail(event.sender, nonce, error instanceof Error ? error.message : String(error));
    }
  }

  /** Starts once and chooses source-tree versus packaged artifact entry points. */
  private start(): UtilityProcess {
    if (this.utilityProcess) return this.utilityProcess;
    const utilityProcess = new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService);
    const artifactEntry = this.environmentMainService.isBuilt
      ? resolve(this.environmentMainService.appRoot, 'glyph', 'dist', 'desktop', 'host', 'utilityMain.js')
      : resolve(
          this.environmentMainService.appRoot,
          '..',
          '..',
          '.artifacts',
          'glyph-desktop-host',
          'dist',
          'desktop',
          'host',
          'utilityMain.js',
        );
    if (
      !utilityProcess.start({
        type: 'glyphHost',
        name: 'glyph-host',
        entryPoint: 'vs/platform/glyph/node/glyphHostBootstrap',
        env: { ...process.env, GLYPH_DESKTOP_HOST_ENTRY: artifactEntry },
      })
    ) {
      utilityProcess.dispose();
      throw new Error('The Glyph utility process did not start.');
    }
    this.utilityProcess = utilityProcess;
    this.logService.info(`[Glyph host] utility process started from ${artifactEntry}`);
    this._register(
      utilityProcess.onExit(() => {
        if (this.utilityProcess === utilityProcess) this.utilityProcess = undefined;
        for (const sender of this.senders.values()) {
          if (!sender.isDestroyed()) sender.send('vscode:glyph:hostExited');
        }
      }),
    );
    this._register(utilityProcess.onStderr(data => this.logService.error(`[Glyph host] ${data}`)));
    return utilityProcess;
  }

  /** Avoids retaining destroyed WebContents while preserving exit notification. */
  private track(sender: WebContents): void {
    if (this.senders.has(sender.id)) return;
    this.senders.set(sender.id, sender);
    sender.once('destroyed', () => this.senders.delete(sender.id));
  }

  /** Correlates setup failures with the renderer's nonce before any port exists. */
  private fail(sender: WebContents, nonce: string, message: string): void {
    if (!sender.isDestroyed()) sender.send(responseChannel, { nonce, error: message });
  }
}
