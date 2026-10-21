import { DisposableStore } from '#vs/base/common/lifecycle.js';
import type { ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import type { IPosition } from '#vs/editor/common/core/position.js';

export class ZoneWidgetStub {
  static readonly instances: ZoneWidgetStub[] = [];
  protected readonly _disposables = new DisposableStore();
  readonly container = document.createElement('div');
  readonly relayouts: number[] = [];
  shown: { position: IPosition; heightInLines: number } | undefined;
  disposed = false;

  constructor(
    readonly editor: ICodeEditor,
    readonly options: object,
  ) {
    ZoneWidgetStub.instances.push(this);
  }

  create(): void {
    document.body.append(this.container);
    this._fillContainer(this.container);
  }

  show(position: IPosition, heightInLines: number): void {
    this.shown = { position, heightInLines };
  }

  protected _fillContainer(_container: HTMLElement): void {}

  protected _relayout(heightInLines: number): void {
    this.relayouts.push(heightInLines);
  }

  dispose(): void {
    this.disposed = true;
    this._disposables.dispose();
    this.container.remove();
  }
}
