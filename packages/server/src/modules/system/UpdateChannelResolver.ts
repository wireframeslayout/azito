import fs from 'fs';
import { getReleaseInfo } from '../../shared/releaseInfo';

interface UpdateChannelFile {
  repo?: string;
  channel?: string;
}

/**
 * Resolves the distribution repository (owner + repo name) used to check for and
 * download hub updates. Resolution order (first non-empty wins):
 *   1. AZITO_RELEASE_REPO env var
 *   2. update-channel.json (written via updateChannel(), e.g. after a
 *      successorRepo migration)
 *   3. release.json's channel.repo (baked in at build time)
 * Returns null when none of the three stages yield a repo — callers must
 * treat that as "update checking unavailable", never fall back to a
 * hardcoded default.
 */
export class UpdateChannelResolver {
  constructor(private channelPath: string) {}

  resolve(): string | null {
    const fromEnv = process.env.AZITO_RELEASE_REPO;
    if (fromEnv) return fromEnv;

    const fromFile = this.readChannelFile();
    if (fromFile?.repo) return fromFile.repo;

    const releaseInfo = getReleaseInfo();
    if (releaseInfo?.channel?.repo) return releaseInfo.channel.repo;

    return null;
  }

  updateChannel(repo: string): void {
    const content: UpdateChannelFile = { ...(this.readChannelFile() ?? {}), repo };
    fs.writeFileSync(this.channelPath, JSON.stringify(content, null, 2), { mode: 0o600 });
  }

  resolveChannel(): 'stable' | 'rc' {
    return this.readChannelFile()?.channel === 'rc' ? 'rc' : 'stable';
  }

  updateChannelKind(kind: 'stable' | 'rc'): void {
    const content: UpdateChannelFile = { ...(this.readChannelFile() ?? {}), channel: kind };
    fs.writeFileSync(this.channelPath, JSON.stringify(content, null, 2), { mode: 0o600 });
  }

  private readChannelFile(): UpdateChannelFile | null {
    try {
      const content = fs.readFileSync(this.channelPath, 'utf-8');
      const parsed = JSON.parse(content) as UpdateChannelFile;
      return parsed;
    } catch {
      return null;
    }
  }
}
