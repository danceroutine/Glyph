import { FloatingClickMenu, FloatingClickWidget } from '#vs/platform/actions/browser/floatingMenu.js';
import { IAction } from '#vs/base/common/actions.js';
import { DisposableStore, toDisposable } from '#vs/base/common/lifecycle.js';
import { mountGlyphContextButton } from './ui/mountGlyphWorkbench.js';

/** Keep native test menu routing and lifecycle, render Glyph's action with the shared button. */
class GlyphTestFailureWidget extends FloatingClickWidget {
  constructor(private readonly glyphLabel: string) {
    super(glyphLabel);
  }
  override render(): void {
    super.render();
    const node = this.getDomNode();
    Object.assign(node.style, { padding: '0', background: 'transparent', border: '0' });
    // The native container's click listener dispatches the selected menu action.
    this._register(mountGlyphContextButton(node, this.glyphLabel, () => {}, true));
  }
}
export class GlyphTestFailureMenu extends FloatingClickMenu {
  protected override createWidget(action: IAction, disposable: DisposableStore): FloatingClickWidget {
    if (action.id !== 'glyph.fixTestFailure') return super.createWidget(action, disposable);
    // Reuse the native widget's insertion point without changing other providers' actions.
    const placeholder = super.createWidget(action, disposable);
    const widget = new GlyphTestFailureWidget(action.label);
    const node = widget.getDomNode();
    placeholder.getDomNode().replaceWith(node);
    placeholder.dispose();
    disposable.add(
      toDisposable(() => {
        node.remove();
      }),
    );
    return widget;
  }
}
