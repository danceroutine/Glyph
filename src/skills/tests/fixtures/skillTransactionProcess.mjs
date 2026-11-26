import { resolve } from 'node:path';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { SkillPackageDraft } from '#src/skills/SkillPackageDraft.js';

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
  mutations: await NativeWorkspaceMutations.open(resolve('target/release/glyph-workspace-mutations'), root),
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
