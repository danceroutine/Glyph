import { describe, expect, it } from 'vitest';
import { WorkspaceAccessPolicy } from '../WorkspaceAccessPolicy.ts';

describe(WorkspaceAccessPolicy, () => {
  describe(WorkspaceAccessPolicy.prototype.isSensitiveFileName, () => {
    it('classifies the shared credential, prefix, extension, and allow-list defaults', () => {
      const policy = new WorkspaceAccessPolicy();

      expect(policy.isSensitiveFileName('.git-credentials')).toBe(true);
      expect(policy.isSensitiveFileName('.env.production')).toBe(true);
      expect(policy.isSensitiveFileName('certificate.pem')).toBe(true);
      expect(policy.isSensitiveFileName('.env.example')).toBe(false);
      expect(policy.isSensitiveFileName('application.ts')).toBe(false);
    });

    it('supports one explicit customized policy for every consumer', () => {
      const policy = new WorkspaceAccessPolicy({
        ignoredDirectories: ['vendor'],
        sensitiveFileNames: ['private.txt'],
        sensitiveFilePrefixes: [],
        sensitiveFileExtensions: [],
        allowedFileNames: [],
      });

      expect(policy.toJSON()).toEqual({
        ignoredDirectories: ['vendor'],
        sensitiveFileNames: ['private.txt'],
        sensitiveFilePrefixes: [],
        sensitiveFileExtensions: [],
        allowedFileNames: [],
      });
      expect(policy.isSensitiveFileName('private.txt')).toBe(true);
      expect(policy.isSensitiveFileName('.env')).toBe(false);
    });
  });
});
