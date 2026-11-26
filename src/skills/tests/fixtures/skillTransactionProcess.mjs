import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import { FileSkillDiscoveryProvider } from '../../FileSkillDiscoveryProvider.ts';
import { SkillPackageManager } from '../../SkillPackageManager.ts';
import { SkillStateStore } from '../../SkillStateStore.ts';
import { SkillCatalog } from '../../SkillCatalog.ts';
import { SkillPackageDraft } from '../../SkillPackageDraft.ts';

const [root, scenario] = process.argv.slice(2);
const store = new FileSystemWorkspaceTextStore(root);
const state = new SkillStateStore(store);
await state.initialize();
const location = {
  id: 'user:glyph',
  scope: 'user',
  label: 'User skills',
  directory: 'skills',
  store,
  workspace: store,
  listFiles: () => store.list(10000, 'skills/**/*'),
  refreshIndex: async () => {},
};
const provider = new FileSkillDiscoveryProvider({
  ...location,
  origin: { id: location.id, scope: location.scope, label: location.label, compatibility: 'glyph' },
  binaryStore: store,
  uriForPath: path => path,
});
const catalog = new SkillCatalog([provider], state.enabled, state.installations);
const manager = new SkillPackageManager([location], catalog, state);
await catalog.refresh();
const installed = catalog.skills[0];
if (scenario === 'crash') {
  state.record = async () => process.exit(53);
  const draft = new SkillPackageDraft({
    name: 'example',
    source: 'Child import',
    files: [
      {
        path: 'SKILL.md',
        content: '---\nname: example\ndescription: Crash fixture\n---\nChanged in child',
        encoding: 'utf8',
      },
    ],
  });
  const preview = await manager.prepare(location.id, draft, installed.id);
  await manager.apply(preview.id);
} else {
  const forget = state.forget.bind(state);
  state.forget = async id => {
    process.send('removed');
    await new Promise(accept => {
      process.once('message', accept);
    });
    return forget(id);
  };
  const preview = await manager.prepareRemoval(installed.id);
  await manager.apply(preview.id);
  process.disconnect();
}
