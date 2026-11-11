import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { execPosixRemote, posixRemoteCommand } from './posixRemoteCommand';

const exec = promisify(execFile);
const ssh = { execIsolated: async (_host: string, command: string) => {
  const result = await exec('/bin/bash', ['-c', command]);
  return { ...result, code: 0 };
} };

describe('execPosixRemote', () => {
  it.each([['printf foo; exit 7', 'foo', 7], ['exit 113', '', 113], ["printf 'hello\\n'", 'hello\n', 0]])('preserves output and exit status: %s', async (script, stdout, code) => {
    await expect(execPosixRemote(ssh as never, 'host', script)).resolves.toMatchObject({ stdout, code });
  });
  it('rejects missing or malformed markers', async () => {
    const broken = { execIsolated: async () => ({ stdout: 'no marker', stderr: '', code: 0 }) };
    await expect(execPosixRemote(broken as never, 'host', 'true')).rejects.toThrow(/marker/);
  });
});

 it.skipIf(process.platform === 'win32')('quotes shell syntax for the login shell', () => {
  const command = posixRemoteCommand(`value="a'b"\nprintf '%s\\n' "$value"`);
  expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe("a'b\n");
});
