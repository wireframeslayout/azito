import type { IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';

/**
 * Where the hub's own machine keeps the agent CLIs' session files when the environment overrides the default
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); null = the default under the home directory. Resolved once at the composition root.
 * Only the hub's own server can use it: the environment of an agent server's process is not known to the hub, so a session
 * scan of an agent server looks at the default directories.
 */
export interface LocalAgentHomes {
  claudeConfigDir: string | null;
  codexHome: string | null;
}

/** An unset or empty variable is no override. */
export function localAgentHomesFromEnv(env: NodeJS.ProcessEnv): LocalAgentHomes {
  return { claudeConfigDir: env.CLAUDE_CONFIG_DIR || null, codexHome: env.CODEX_HOME || null };
}

/** `~/.claude` (or `CLAUDE_CONFIG_DIR` on the hub's own server): the directory that holds `projects/`. */
export async function claudeConfigDirOf(files: IFileOps, isLocal: boolean, homes: LocalAgentHomes): Promise<string> {
  if (isLocal && homes.claudeConfigDir !== null) return homes.claudeConfigDir;
  return pathApiFor(files.platform).join(await files.realpath('~'), '.claude');
}

/** `~/.codex` (or `CODEX_HOME` on the hub's own server): the directory that holds `sessions/`. */
export async function codexHomeOf(files: IFileOps, isLocal: boolean, homes: LocalAgentHomes): Promise<string> {
  if (isLocal && homes.codexHome !== null) return homes.codexHome;
  return pathApiFor(files.platform).join(await files.realpath('~'), '.codex');
}
