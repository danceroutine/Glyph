import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#glyph/protocol/index.js';
import { GlyphAgentReviewScope } from '#glyph/workbench/GlyphAgentReview.js';
import { GlyphComposerCommand } from '#glyph/workbench/GlyphComposerCommand.js';
import { GlyphFollowUpBehavior } from '#glyph/workbench/GlyphFollowUpBehavior.js';
import { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import { URI } from '#vs/base/common/uri.js';
import { MenuId, MenuRegistry } from '#vs/platform/actions/common/actions.js';
import { CommandsRegistry } from '#vs/platform/commands/common/commands.js';
import {
  Extensions as ConfigurationExtensions,
  type IConfigurationRegistry,
} from '#vs/platform/configuration/common/configurationRegistry.js';
import { KeybindingsRegistry } from '#vs/platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '#vs/platform/notification/common/notification.js';
import { Registry } from '#vs/platform/registry/common/platform.js';
import { Extensions, type IViewContainersRegistry, type IViewsRegistry } from '#vs/workbench/common/views.js';
import { IExplorerService } from '#vs/workbench/contrib/files/browser/files.js';
import { useGlyphContext } from '#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { IViewsService } from '#vs/workbench/services/views/common/viewsService.js';
import '#vs/workbench/contrib/glyph/electron-browser/glyph.contribution.js';

vi.mock('#vs/workbench/contrib/glyph/browser/GlyphAgentReviewPane.js', () => ({
  GlyphAgentReviewPane: class {
    static readonly ID = 'glyph.agentReview';
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphBuiltinChat.js', () => ({
  GlyphBuiltinChat: class {
    static readonly ID = 'workbench.contrib.glyphBuiltinChat';
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js', () => ({
  GlyphDiagnosticHover: class {},
  GlyphTerminalSelectionActions: class {
    static readonly ID = 'workbench.contrib.glyphTerminalSelectionActions';
  },
  useGlyphContext: vi.fn(async () => {}),
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphPlanEditor.js', () => ({
  GlyphPlanEditor: class {
    static readonly ID = 'glyph.planEditor';
  },
  GlyphPlanInput: class {},
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphViewPane.js', () => ({
  GlyphViewPane: class {
    static readonly ID = 'glyph.view';
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/NativeGlyphWorkbenchService.js', () => ({
  NativeGlyphWorkbenchService: class {},
}));
vi.mock('#vs/workbench/browser/parts/views/viewPaneContainer.js', () => ({ ViewPaneContainer: class {} }));

function workbench({ selected = [] as URI[], attach = async () => {} } = {}) {
  const glyph = {
    composer: { focus: vi.fn(), executeCommand: vi.fn() },
    ideContext: { terminal: vi.fn(async () => []), captureTestFailure: vi.fn(async () => []) },
    attachExplorerResources: vi.fn(attach),
    attachSelection: vi.fn(async () => {}),
    attachIdeContext: vi.fn(async () => {}),
    executeReviewCommand: vi.fn(),
  };
  const views = { openView: vi.fn(async () => undefined) };
  const notifications = { error: vi.fn() };
  const explorer = { getContext: vi.fn(() => selected.map(resource => ({ resource }))) };
  const services = new Map<unknown, unknown>([
    [GlyphWorkbenchService, glyph],
    [IViewsService, views],
    [INotificationService, notifications],
    [IExplorerService, explorer],
  ]);
  const run = (id: string, ...args: unknown[]) => {
    let valid = true;
    const accessor = {
      get: (service: unknown) => {
        if (!valid)
          throw new Error('Illegal state: service accessor is only valid during the invocation of its target method');
        return services.get(service);
      },
    };
    const result = CommandsRegistry.getCommand(id)!.handler(accessor as never, ...args);
    valid = false;
    return result;
  };
  return { glyph, views, notifications, explorer, run };
}

describe('glyph.contribution', () => {
  it('registers the Glyph view and its settings', () => {
    const containers = Registry.as<IViewContainersRegistry>(Extensions.ViewContainersRegistry);
    const views = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);
    const configuration = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

    const container = containers.get('workbench.view.glyphContainer');
    expect(container).toBeDefined();
    expect(views.getViews(container!).map(view => view.id)).toEqual(['glyph.view']);
    expect(views.getView('glyph.agentReview')).toBeNull();
    expect(configuration.getConfigurationProperties()).toMatchObject({
      'glyph.review.scope': { default: GlyphAgentReviewScope.LAST_COMMIT },
      'glyph.review.baseBranch': { default: '' },
      'glyph.preferOpeningWebLinksInGlyph': { default: false },
      'glyph.chat.followUpBehavior': { default: GlyphFollowUpBehavior.QUEUE },
      'glyph.modeSwitch.autoApprove': { default: false },
      'glyph.modeSwitch.timeoutSeconds': { default: 15, minimum: 5, maximum: 300 },
    });
  });

  it('offers explorer resources to current and new Glyph chats', () => {
    const items = MenuRegistry.getMenuItems(MenuId.ExplorerContext).filter(item => item.group === '7_glyph');

    expect(items.map(item => ('command' in item ? item.command.id : undefined)).sort()).toEqual([
      'glyph.addExplorerDirectoryToChat',
      'glyph.addExplorerDirectoryToNewChat',
      'glyph.addExplorerFileToChat',
      'glyph.addExplorerFileToNewChat',
    ]);
  });

  it('binds composer and review shortcuts', () => {
    const bound = new Set(KeybindingsRegistry.getDefaultKeybindings().map(rule => rule.command));

    for (const id of [...Object.values(GlyphComposerCommand), ...Object.values(GlyphReviewCommand)])
      expect(bound.has(id)).toBe(true);
    expect(bound.has('glyph.attachSelection')).toBe(true);
    expect(bound.has('glyph.attachTerminalSelection')).toBe(true);
  });

  describe('explorer actions', () => {
    it('attaches the explorer selection to the current chat and reveals Glyph', async () => {
      const selected = [URI.file('/project/a.ts'), URI.file('/project/b.ts')];
      const { glyph, views, run } = workbench({ selected });

      await run('glyph.addExplorerFileToChat', selected[1]);

      expect(glyph.attachExplorerResources).toHaveBeenCalledWith(
        ['file:///project/a.ts', 'file:///project/b.ts'],
        false,
      );
      expect(views.openView).toHaveBeenCalledWith('glyph.view', true);
      expect(glyph.composer.focus).toHaveBeenCalled();
    });

    it('attaches a resource outside the selection to a new chat on its own', async () => {
      const { glyph, run } = workbench({ selected: [URI.file('/project/a.ts')] });

      await run('glyph.addExplorerDirectoryToNewChat', URI.file('/project/src'));

      expect(glyph.attachExplorerResources).toHaveBeenCalledWith(['file:///project/src'], true);
    });

    it('attaches the selection when no resource is given', async () => {
      const { glyph, run } = workbench({ selected: [URI.file('/project/src')] });

      await run('glyph.addExplorerDirectoryToChat');

      expect(glyph.attachExplorerResources).toHaveBeenCalledWith(['file:///project/src'], false);
    });

    it('reports attachment failures without revealing Glyph', async () => {
      const failure = new Error('Wait for the current chat transition.');
      const { views, notifications, run } = workbench({
        attach: async () => {
          throw failure;
        },
      });

      await run('glyph.addExplorerFileToNewChat', URI.file('/project/a.ts'));

      expect(notifications.error).toHaveBeenCalledWith(failure);
      expect(views.openView).not.toHaveBeenCalled();
    });

    it('reports non-error attachment failures as text', async () => {
      const { notifications, run } = workbench({
        attach: async () => {
          throw 'busy';
        },
      });

      await run('glyph.addExplorerFileToChat', URI.file('/project/a.ts'));

      expect(notifications.error).toHaveBeenCalledWith('busy');
    });
  });

  it('attaches the editor selection and reveals Glyph', async () => {
    const { glyph, views, run } = workbench();

    await run('glyph.attachSelection');

    expect(glyph.attachSelection).toHaveBeenCalled();
    expect(views.openView).toHaveBeenCalledWith('glyph.view', true);
    expect(glyph.composer.focus).toHaveBeenCalled();
  });

  it('attaches IDE context and reveals Glyph', async () => {
    const { glyph, views, run } = workbench();

    await run('glyph.attachIdeContext');

    expect(glyph.attachIdeContext).toHaveBeenCalled();
    expect(views.openView).toHaveBeenCalledWith('glyph.view', true);
    expect(glyph.composer.focus).toHaveBeenCalled();
  });

  it('forwards composer commands to the composer', () => {
    const { glyph, run } = workbench();

    for (const id of Object.values(GlyphComposerCommand)) run(id);

    expect(glyph.composer.executeCommand.mock.calls).toEqual(Object.values(GlyphComposerCommand).map(id => [id]));
  });

  it('forwards review commands to the review editor', () => {
    const { glyph, run } = workbench();

    for (const id of Object.values(GlyphReviewCommand)) run(id);

    expect(glyph.executeReviewCommand.mock.calls).toEqual(Object.values(GlyphReviewCommand).map(id => [id]));
  });

  it('adds the terminal selection to the chat', async () => {
    const { glyph, views, run } = workbench();

    await run('glyph.attachTerminalSelection');

    expect(useGlyphContext).toHaveBeenLastCalledWith(glyph, views, expect.any(Function));
    await vi.mocked(useGlyphContext).mock.lastCall![2]();
    expect(glyph.ideContext.terminal).toHaveBeenCalled();
  });

  describe('fix test failure', () => {
    it('asks an agent to fix the opened test failure', async () => {
      const { glyph, views, run } = workbench();

      await run('glyph.fixTestFailure', {
        test: { item: { extId: 'suite/test' } },
        glyphResultId: 'result',
        glyphTaskIndex: 0,
        glyphMessageIndex: 2,
      });

      expect(useGlyphContext).toHaveBeenLastCalledWith(
        glyph,
        views,
        expect.any(Function),
        'Investigate and fix the attached test failure. Check its source and run identity, reproduce when possible, and verify the fix.',
        AgentModeID.AGENT,
      );
      await vi.mocked(useGlyphContext).mock.lastCall![2]();
      expect(glyph.ideContext.captureTestFailure).toHaveBeenCalledWith('result', 'suite/test', 0, 2);
    });

    it('requires an opened test failure message', async () => {
      const { run } = workbench();
      const test = { item: { extId: 'suite/test' } };

      for (const context of [
        undefined,
        { test, glyphTaskIndex: 0, glyphMessageIndex: 0 },
        { test, glyphResultId: 'result', glyphMessageIndex: 0 },
        { test, glyphResultId: 'result', glyphTaskIndex: 0 },
      ])
        await expect(run('glyph.fixTestFailure', context)).rejects.toThrow(
          'Open the test failure message to fix it with Glyph.',
        );
    });
  });
});
