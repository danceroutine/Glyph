import { mkdir, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { sourceEvidence } from './source-evidence.mjs';

/** Companion to runner-owned JSON results; source changes invalidate the evidence. */
export default class SecurityReporter {
  constructor({ root = process.cwd(), snapshot = sourceEvidence } = {}) {
    this.root = root;
    this.snapshot = snapshot;
  }

  async onTestRunStart() {
    this.startedAt = new Date().toISOString();
    this.before = await this.snapshot(this.root);
  }

  /** @param {unknown[]} _modules @param {unknown[]} errors @param {string} reason */
  async onTestRunEnd(_modules, errors, reason) {
    const after = await this.snapshot(this.root);
    const valid = this.before.fingerprint === after.fingerprint;
    const directory = resolve(this.root, '.artifacts/security');
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, 'source.json'),
      JSON.stringify(
        {
          startedAt: this.startedAt,
          finishedAt: new Date().toISOString(),
          platform: platform(),
          architecture: arch(),
          release: release(),
          node: process.version,
          source: this.before,
          finalFingerprint: after.fingerprint,
          valid,
          runnerOutcome: reason,
          unhandledErrorCount: errors.length,
          results: 'results.json',
        },
        null,
        2,
      ),
    );
    if (!valid) throw new Error('Security evidence invalid: source files changed during execution.');
  }
}
