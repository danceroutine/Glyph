import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Event } from '#vs/base/common/event.js';
import { Dimension } from '#vs/base/browser/dom.js';
import { CancellationToken } from '#vs/base/common/cancellation.js';
import type { IStorageService } from '#vs/platform/storage/common/storage.js';
import type { ITelemetryService } from '#vs/platform/telemetry/common/telemetry.js';
import type { IThemeService } from '#vs/platform/theme/common/themeService.js';
import type { IEditorGroup } from '#vs/workbench/services/editor/common/editorGroupsService.js';
import { EditorInput } from '#vs/workbench/common/editor/editorInput.js';
import { URI } from '#vs/base/common/uri.js';
import type { GlyphPlanViewActions, GlyphPlanViewState } from '#glyph/workbench/GlyphPlanView.js';
import { GlyphPlanEditor, GlyphPlanInput } from '#vs/workbench/contrib/glyph/browser/GlyphPlanEditor.js';

const mounts = vi.hoisted(() => ({ mountGlyphPlan: vi.fn() }));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);

const stateOf = (id: string, title = 'Ship it') =>
  ({ plan: { id, title }, disabled: false, agents: [] }) as unknown as GlyphPlanViewState;

const inputOf = (id: string, title?: string) => {
  let state = stateOf(id, title);
  const listeners = new Set<() => void>();
  const subscription = { dispose: vi.fn() };
  const input = new GlyphPlanInput(
    () => state,
    {} as GlyphPlanViewActions,
    listener => {
      listeners.add(listener);
      subscription.dispose.mockImplementation(() => listeners.delete(listener));
      return subscription;
    },
  );
  return {
    input,
    subscription,
    publish(next: GlyphPlanViewState) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
};

const viewOf = () => {
  const view = { update: vi.fn(), dispose: vi.fn() };
  mounts.mountGlyphPlan.mockReturnValueOnce(view);
  return view;
};

const editorOf = (create = true) => {
  const editor = new GlyphPlanEditor(
    {} as IEditorGroup,
    {} as ITelemetryService,
    { getColorTheme: () => ({}), onDidColorThemeChange: Event.None } as unknown as IThemeService,
    { onWillSaveState: Event.None } as unknown as IStorageService,
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  onTestFinished(() => {
    editor.dispose();
    parent.remove();
    mounts.mountGlyphPlan.mockReset();
  });
  if (create) editor.create(parent);
  return { editor, parent };
};

describe(GlyphPlanInput, () => {
  it('names and identifies the plan document', () => {
    const { input } = inputOf('plan-1', 'Ship it');

    expect(input.typeId).toBe(GlyphPlanInput.ID);
    expect(input.getName()).toBe('Ship it');
    expect(input.resource.toString()).toBe('glyph-plan:/plan-1');
  });

  describe(GlyphPlanInput.prototype.matches, () => {
    it('matches inputs for the same plan', () => {
      const { input } = inputOf('plan-1');

      expect(input.matches(input)).toBe(true);
      expect(input.matches(inputOf('plan-1').input)).toBe(true);
      expect(input.matches(inputOf('plan-2').input)).toBe(false);
      expect(input.matches({ resource: URI.parse('file:///plan-1') })).toBe(false);
      expect(
        input.matches(
          new (class extends EditorInput {
            override get typeId() {
              return 'other';
            }
            override get resource() {
              return URI.parse('glyph-plan:/plan-1');
            }
          })(),
        ),
      ).toBe(false);
    });
  });
});

describe(GlyphPlanEditor, () => {
  it('creates a focusable container', () => {
    const { editor, parent } = editorOf();

    editor.focus();

    expect(parent.lastElementChild).toBe(document.activeElement);
    expect((parent.lastElementChild as HTMLElement).tabIndex).toBe(0);
  });

  describe(GlyphPlanEditor.prototype.setInput, () => {
    it('renders the plan and follows its updates', async () => {
      const { editor, parent } = editorOf();
      const { input, publish } = inputOf('plan-1');
      const view = viewOf();

      await editor.setInput(input, undefined, {}, CancellationToken.None);
      publish(stateOf('plan-1', 'Renamed'));

      expect(mounts.mountGlyphPlan).toHaveBeenCalledWith(parent.lastElementChild, stateOf('plan-1'), input.actions);
      expect(view.update).toHaveBeenCalledWith(stateOf('plan-1', 'Renamed'));
    });

    it('replaces the previous plan', async () => {
      const { editor } = editorOf();
      const first = inputOf('plan-1');
      const second = inputOf('plan-2');
      const view = viewOf();
      viewOf();

      await editor.setInput(first.input, undefined, {}, CancellationToken.None);
      await editor.setInput(second.input, undefined, {}, CancellationToken.None);

      expect(first.subscription.dispose).toHaveBeenCalled();
      expect(view.dispose).toHaveBeenCalled();
      expect(mounts.mountGlyphPlan).toHaveBeenCalledTimes(2);
    });

    it('renders nothing for cancelled, foreign, or premature inputs', async () => {
      const cancelled = editorOf();
      const foreign = editorOf();
      const premature = editorOf(false);

      await cancelled.editor.setInput(inputOf('plan-1').input, undefined, {}, CancellationToken.Cancelled);
      await foreign.editor.setInput(
        new (class extends EditorInput {
          override get typeId() {
            return 'other';
          }
          override get resource() {
            return undefined;
          }
        })(),
        undefined,
        {},
        CancellationToken.None,
      );
      await premature.editor.setInput(inputOf('plan-1').input, undefined, {}, CancellationToken.None);

      expect(mounts.mountGlyphPlan).not.toHaveBeenCalled();
    });
  });

  describe(GlyphPlanEditor.prototype.layout, () => {
    it('sizes the plan to the editor', () => {
      const { editor, parent } = editorOf();

      editor.layout(new Dimension(320, 240));

      expect((parent.lastElementChild as HTMLElement).style.width).toBe('320px');
      expect((parent.lastElementChild as HTMLElement).style.height).toBe('240px');
    });

    it('ignores layout before the editor is created', () => {
      const { editor, parent } = editorOf(false);

      editor.layout(new Dimension(320, 240));
      editor.focus();

      expect(parent.childElementCount).toBe(0);
    });
  });

  describe(GlyphPlanEditor.prototype.clearInput, () => {
    it('releases the rendered plan', async () => {
      const { editor } = editorOf();
      const { input, subscription } = inputOf('plan-1');
      const view = viewOf();
      await editor.setInput(input, undefined, {}, CancellationToken.None);

      editor.clearInput();

      expect(subscription.dispose).toHaveBeenCalled();
      expect(view.dispose).toHaveBeenCalled();
      expect(editor.input).toBeUndefined();
    });
  });

  describe(GlyphPlanEditor.prototype.dispose, () => {
    it('releases the rendered plan', async () => {
      const { editor } = editorOf();
      const { input, subscription } = inputOf('plan-1');
      const view = viewOf();
      await editor.setInput(input, undefined, {}, CancellationToken.None);

      editor.dispose();

      expect(subscription.dispose).toHaveBeenCalled();
      expect(view.dispose).toHaveBeenCalled();
    });
  });
});
