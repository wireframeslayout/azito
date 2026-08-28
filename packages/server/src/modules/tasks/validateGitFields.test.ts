import { describe, it, expect } from 'vitest';
import { validateGitFields } from './routes';

describe('validateGitFields', () => {
  it('accepts normal branch names, including ones containing slashes', () => {
    expect(validateGitFields({ branch: 'main' })).toBeNull();
    expect(validateGitFields({ branch: 'feature/x' })).toBeNull();
    expect(validateGitFields({ base_branch: 'task/123-fix-bug' })).toBeNull();
    expect(validateGitFields({ target_branch: 'release/v1.2.3' })).toBeNull();
  });

  it('rejects a fully-qualified ref in branch (Issue #87 9th round, Important 1)', () => {
    expect(validateGitFields({ branch: 'refs/heads/main' })).toMatch(/branch/);
  });

  it('rejects a fully-qualified ref in base_branch', () => {
    expect(validateGitFields({ base_branch: 'refs/heads/main' })).toMatch(/base_branch/);
  });

  it('rejects a fully-qualified ref in target_branch', () => {
    expect(validateGitFields({ target_branch: 'refs/heads/main' })).toMatch(/target_branch/);
  });

  it('rejects other unsafe branch characters as before', () => {
    expect(validateGitFields({ branch: 'main; touch x' })).toMatch(/Invalid branch/);
  });

  it('ignores null/empty branch fields', () => {
    expect(validateGitFields({ branch: null, base_branch: '', target_branch: undefined })).toBeNull();
  });
});
