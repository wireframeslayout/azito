import { execFile } from 'child_process';
import { promisify } from 'util';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import { execGitOrThrow, execWithSentinel } from './execWithSentinel';
import { shellQuote } from '../../shared/shellQuote';

const execFileAsync = promisify(execFile);

// `git config <key>` exits 1 when the key is unset; that is the only exit
// status treated as "missing". Any other failure propagates.
const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;

export async function getGitConfigValue(
  serverType: string,
  transport: IServerTransport | undefined,
  worktreePath: string,
  key: string,
): Promise<string> {
  if (serverType === 'local') {
    try {
      const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'config', key]);
      return stdout.trim();
    } catch (err) {
      if ((err as { code?: unknown }).code === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return '';
      throw err;
    }
  }
  if (!transport) throw new Error('Transport required for remote git config');
  const outcome = await execWithSentinel(transport, `git -C ${shellQuote(worktreePath)} config ${key}`, 10_000);
  if (outcome.ok) return outcome.stdout.trim();
  if (outcome.sentinelFound && outcome.exitCode === GIT_CONFIG_KEY_UNSET_EXIT_CODE) return '';
  throw new Error(`git config ${key} read failed: ${outcome.stdout || outcome.stderr || 'command did not complete'}`);
}

export async function setGitConfigValue(
  serverType: string,
  transport: IServerTransport | undefined,
  worktreePath: string,
  key: string,
  value: string,
): Promise<void> {
  if (serverType === 'local') {
    await execFileAsync('git', ['-C', worktreePath, 'config', key, value]);
    return;
  }
  if (!transport) throw new Error('Transport required for remote git config');
  await execGitOrThrow(
    transport,
    `git -C ${shellQuote(worktreePath)} config ${key} ${shellQuote(value)} 2>&1`,
    10_000,
    `git config ${key} failed`,
  );
}
