import { randomBytes } from 'node:crypto';
import { shellQuote } from '../../../shared/shellQuote';
import type { SshClient } from '../ssh/SshClient';

/** Run deploy scripts with Bash regardless of the target user's login shell. */
export function posixRemoteCommand(script: string): string {
  return `/bin/bash -c ${shellQuote(script)}`;
}

export class PosixRemoteProtocolError extends Error {}

/** Recover the remote shell status independently of the SSH server's exit status. */
export async function execPosixRemote(ssh: Pick<SshClient, 'execIsolated'>, host: string, script: string, timeoutMs?: number): ReturnType<SshClient['execIsolated']> {
  const marker = `AZITO_EXIT_${randomBytes(16).toString('hex')}`;
  const command = `${posixRemoteCommand(script)}; printf '\\n${marker}:%s\\n' "$?"`;
  let result: Awaited<ReturnType<SshClient['execIsolated']>>;
  try {
    result = await ssh.execIsolated(host, command, timeoutMs);
  } catch (cause) {
    throw new PosixRemoteProtocolError('Remote command transport failed', { cause });
  }
  if (result.code !== 0) throw new PosixRemoteProtocolError('Remote command transport failed');
  const pattern = new RegExp(`\\n${marker}:(\\d+)\\n$`);
  const match = pattern.exec(result.stdout);
  if (!match || result.stdout.indexOf(marker) !== match.index + 1 || Number(match[1]) > 255) {
    throw new PosixRemoteProtocolError('Remote command exit marker is missing or invalid');
  }
  return { ...result, stdout: result.stdout.slice(0, match.index), code: Number(match[1]) };
}
