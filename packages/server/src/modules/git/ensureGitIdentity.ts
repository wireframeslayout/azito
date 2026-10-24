import type { GitTransport } from './gitPath';
import { getGitConfigValue, setGitConfigValue } from './gitConfigOps';

export type GitIdentity = { name: string; email: string };

export type EnsureGitIdentityResult =
  | { action: 'already_set' }
  | { action: 'applied'; fields: Array<{ key: string; value: string }> }
  | { action: 'hub_missing' };

export async function ensureGitIdentity(
  transport: GitTransport,
  worktreePath: string,
  hubIdentity: GitIdentity | null,
): Promise<EnsureGitIdentityResult> {
  const currentName = await getGitConfigValue(transport, worktreePath, 'user.name');
  const currentEmail = await getGitConfigValue(transport, worktreePath, 'user.email');

  const missingName = !currentName;
  const missingEmail = !currentEmail;

  if (!missingName && !missingEmail) return { action: 'already_set' };

  if (!hubIdentity) return { action: 'hub_missing' };

  const applied: Array<{ key: string; value: string }> = [];

  if (missingName) {
    await setGitConfigValue(transport, worktreePath, 'user.name', hubIdentity.name);
    applied.push({ key: 'user.name', value: hubIdentity.name });
  }
  if (missingEmail) {
    await setGitConfigValue(transport, worktreePath, 'user.email', hubIdentity.email);
    applied.push({ key: 'user.email', value: hubIdentity.email });
  }

  return { action: 'applied', fields: applied };
}
