import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { posixRemoteCommand } from './posixRemoteCommand';

describe('POSIX remote command', () => {
  it('passes shell syntax, quotes and newlines to bash without evaluating them in the login shell', () => {
    const command = posixRemoteCommand(`value="a'b"\nprintf '%s\\n' "$value"`);
    expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe("a'b\n");
  });
});
