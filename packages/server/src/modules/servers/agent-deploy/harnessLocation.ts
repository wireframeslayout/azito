import { FileOpsError, type IFileOps } from '../../../shared/fs/fileOps';
import { pathApiFor } from '../../../shared/os/hostPath';
import type { HostPlatform } from '../../../shared/os/hostEnv';

/** Where the harness and its env file are on a host, in that host's path notation. */
export interface HarnessLocation {
  /** `<home>/.azito/harness[-<prefix>]`: the copy the hub sends. */
  harnessDir: string;
  versionFile: string;
  /** `<home>/.azito/azitoctl[-<prefix>].env`: written by setup, holds the hub URL. */
  envFile: string;
  /** `<harnessDir>/skills` */
  skillsDir: string;
  /** `<home>/.claude/skills`: where setup puts the `azt-*` skills. */
  claudeSkillsDir: string;
}

export function harnessLocation(platform: HostPlatform, homeDir: string, prefix?: string): HarnessLocation {
  const api = pathApiFor(platform);
  const suffix = prefix ? `-${prefix}` : '';
  const harnessDir = api.join(homeDir, '.azito', `harness${suffix}`);
  return {
    harnessDir,
    versionFile: api.join(harnessDir, 'VERSION'),
    envFile: api.join(homeDir, '.azito', `azitoctl${suffix}.env`),
    skillsDir: api.join(harnessDir, 'skills'),
    claudeSkillsDir: api.join(homeDir, '.claude', 'skills'),
  };
}

/** The home directory of the host that owns `files` (the hub for a local server, the agent for an agent server). */
export function homeDirOf(files: IFileOps): Promise<string> {
  return files.realpath('~');
}

/** The content of a small text file, or null when it does not exist. Any other failure is thrown. */
export async function readTextIfPresent(files: IFileOps, filePath: string): Promise<string | null> {
  try {
    return (await files.read(filePath, { maxBytes: 64 * 1024 })).data.toString('utf8');
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}
