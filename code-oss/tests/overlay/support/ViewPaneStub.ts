import { Disposable } from '#vs/base/common/lifecycle.js';
import type { IConfigurationService } from '#vs/platform/configuration/common/configuration.js';
import type { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';

export class ViewPaneStub extends Disposable {
  readonly id: string;
  readonly renderedBodies: HTMLElement[] = [];
  protected readonly configurationService: IConfigurationService;
  protected readonly instantiationService: IInstantiationService;

  constructor(
    options: { id: string },
    _keybindingService: unknown,
    _contextMenuService: unknown,
    configurationService: IConfigurationService,
    _contextKeyService: unknown,
    _viewDescriptorService: unknown,
    instantiationService: IInstantiationService,
  ) {
    super();
    this.id = options.id;
    this.configurationService = configurationService;
    this.instantiationService = instantiationService;
  }

  protected renderBody(container: HTMLElement): void {
    this.renderedBodies.push(container);
  }
}
