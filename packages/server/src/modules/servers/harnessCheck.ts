import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { harnessLocation, homeDirOf, readTextIfPresent } from './agent-deploy/harnessLocation';

/**
 * What `parseHarnessCheck` reads: the first line names a place where the harness is installed (the hub's copy of the skills, or
 * any `azt-*` skill of `~/.claude/skills`), empty when none is; the second line is the copy's VERSION. Found with the host's
 * `IFileOps`, so it is the same on every OS.
 */
export async function readHarnessCheck(files: IFileOps, prefix?: string): Promise<string> {
  const location = harnessLocation(files.platform, await homeDirOf(files), prefix);
  const installedAt = await findInstalledSkills(files, location.skillsDir, location.claudeSkillsDir);
  if (installedAt === null) return '';
  const version = await readTextIfPresent(files, location.versionFile);
  return `${installedAt}\n${version?.trim() ?? ''}\n`;
}

async function findInstalledSkills(files: IFileOps, harnessSkillsDir: string, claudeSkillsDir: string): Promise<string | null> {
  const copy = await files.stat(harnessSkillsDir);
  if (copy?.kind === 'directory') return harnessSkillsDir;
  try {
    const entry = (await files.list(claudeSkillsDir)).find((e) => e.name.startsWith('azt-'));
    return entry ? `${claudeSkillsDir}/${entry.name}` : null;
  } catch (err) {
    if (err instanceof FileOpsError && (err.code === 'NOT_FOUND' || err.code === 'NOT_A_DIRECTORY')) return null;
    throw err;
  }
}
