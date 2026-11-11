import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { LocalNetworkPermissionError } from '../localNetworkDiagnosis';
import { execPosixRemote, posixRemoteCommand } from './posixRemoteCommand';

const exec = promisify(execFile);
const ssh = { execIsolated: async (_host: string, command: string) => {
  const result = await exec('/bin/sh', ['-c', command]);
  return { ...result, code: 0 };
} };

describe('execPosixRemote', () => {
  it.each([['printf foo; exit 7', 'foo', 7], ['exit 113', '', 113], ["printf 'first\\nsecond'", 'first\nsecond', 0], ["printf 'hello\\n'", 'hello\n', 0]])('preserves output and exit status: %s', async (script, stdout, code) => {
    await expect(execPosixRemote(ssh as never, 'host', script)).resolves.toMatchObject({ stdout, code });
  });
  it('places both the script and the status capture inside bash', async () => {
    let command = '';
    await execPosixRemote({ execIsolated: async (host: string, raw: string) => { command = raw; return ssh.execIsolated(host, raw); } } as never, 'host', 'exit 7');
    expect(command).toMatch(/^\/bin\/bash -c '/);
    expect(command.endsWith("'")).toBe(true);
  });
  it('preserves transport diagnostics and local network permission errors', async () => {
    const denied = new LocalNetworkPermissionError('network denied');
    const failed = (error: Error) => ({ execIsolated: async () => { throw error; } });
    await expect(execPosixRemote(failed(denied) as never, 'host', 'true')).rejects.toBe(denied);
    await expect(execPosixRemote(failed(new Error('connection reset')) as never, 'host', 'true')).rejects.toThrow('connection reset');
  });
  it('rejects a nonzero SSH transport status', async () => {
    await expect(execPosixRemote({ execIsolated: async () => ({ stdout: '', stderr: '', code: 7 }) } as never, 'host', 'true')).rejects.toThrow(/transport failed/);
  });
  it('keeps a fake marker line in command output', async () => {
    await expect(execPosixRemote(ssh as never, 'host', "printf 'AZITO_EXIT_fake:0\\nother'")).resolves.toMatchObject({ stdout: 'AZITO_EXIT_fake:0\nother', code: 0 });
  });
  it.skipIf(process.platform === 'win32')('does not match its own shells when searching with a bracketed pattern', async () => {
    const suffix = randomBytes(16).toString('hex');
    const result = await execPosixRemote(ssh as never, 'host', `pgrep -f '[a]zito_test_${suffix}' >/dev/null; status=$?; printf '%s' "$status"; true`);
    expect(result).toMatchObject({ stdout: '1', code: 0 });
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
