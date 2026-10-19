import { describe, it, expect } from 'vitest';
import { resolveLoginShell } from './loginShell';

describe('resolveLoginShell', () => {
  it('prefers $SHELL', () => {
    expect(resolveLoginShell({ SHELL: '/bin/zsh' }, () => '/bin/bash')).toBe('/bin/zsh');
  });

  it('falls back to the passwd login shell when $SHELL is missing or empty (run.sh, env -i)', () => {
    expect(resolveLoginShell({}, () => '/bin/bash')).toBe('/bin/bash');
    expect(resolveLoginShell({ SHELL: '' }, () => '/usr/bin/fish')).toBe('/usr/bin/fish');
  });

  it('is null, not /bin/sh, when neither exists', () => {
    expect(resolveLoginShell({}, () => null)).toBeNull();
    expect(resolveLoginShell({}, () => '')).toBeNull();
  });

  it('is null when the user has no passwd row (os.userInfo throws)', () => {
    expect(resolveLoginShell({}, () => { throw new Error('ENOENT: no passwd entry'); })).toBeNull();
  });
});
