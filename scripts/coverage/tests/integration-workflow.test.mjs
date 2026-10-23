import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflow = async name => readFile(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');

describe('integration workflow boundaries', () => {
  it('keeps PR and manual CI limited to fresh native and component coverage', async () => {
    const ci = await workflow('ci');
    expect(ci).toContain('  pull_request:');
    expect(ci).toContain('  workflow_dispatch:');
    for (const command of ['pnpm test:native', 'pnpm test:vitest', 'pnpm test:coverage']) expect(ci).toContain(command);
    expect(ci).not.toMatch(/test:all|test:integration|test-electron|recover-electron|GLYPH_COVERAGE_DIR/u);
  });

  it('runs integration only on main pushes with read-only permissions', async () => {
    const integration = await workflow('integration');
    expect(integration).toContain('on:\n  push:\n    branches: [main]\n\npermissions:');
    expect(integration).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(integration).not.toMatch(/pull_request|workflow_dispatch|schedule:|: write/u);
    expect(integration).toContain('cancel-in-progress: false');
    expect(integration).toContain('node scripts/coverage/select-main-electron-tests.mjs');
    expect(integration).toContain('INTEGRATION_BASE_SHA: ${{ steps.selection.outputs.base }}');
    expect(integration).not.toContain('GLYPH_COVERAGE_DIR');
  });

  it('skips expensive preparation for empty selections and saves failure recovery evidence', async () => {
    const integration = await workflow('integration');
    for (const name of [
      'Install native toolchain',
      'Install desktop dependencies',
      'Allow sandbox namespaces',
      'Prepare Code OSS',
    ])
      expect(integration).toContain(`- name: ${name}\n        if: steps.selection.outputs.mode != 'skip'`);
    expect(integration).toContain("if: steps.recovery.outputs.execute == 'true'");
    expect(integration).toContain('GLYPH_ELECTRON_RECOVERY: .artifacts/electron-recovery/last-run.json');
    expect(integration).toContain(
      "if: always() && steps.recovery.outcome == 'success'\n        run: node scripts/coverage/recover-electron-tests.mjs finish",
    );
    expect(integration).toContain('path: .artifacts/electron-recovery/manifest.json');
  });
});
