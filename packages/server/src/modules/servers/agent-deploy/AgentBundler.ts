import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isReleaseMode, getReleaseInfo, getBundleRoot } from '../../../shared/releaseInfo';

const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function getDistDir(): string {
  const bundleRoot = getBundleRoot();
  if (bundleRoot) return path.join(bundleRoot, 'dist-agent');
  return path.join(SERVER_ROOT, 'dist-agent');
}

interface CachedBundleHash {
  tarballMtimeMs: number;
  tarballSize: number;
  hash: string;
}

export class AgentBundler {
  private cachedBundleHash: CachedBundleHash | null = null;

  getHubSha(): string {
    const info = getReleaseInfo();
    if (info) return info.commit;
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: SERVER_ROOT, timeout: 5000 })
      .toString()
      .trim();
  }

  getBundledSha(): string | null {
    try {
      return fs.readFileSync(path.join(getDistDir(), 'version.txt'), 'utf-8').trim();
    } catch {
      return null;
    }
  }

  getTarballPath(): string {
    return path.join(getDistDir(), 'azito-agent.tar.gz');
  }

  /**
   * Hash of the *agent* bundle, i.e. the value the deployed agent reports as its
   * version. Both source and release mode read `dist-agent/bundle-hash.txt`,
   * which build-agent.ts writes alongside the tarball and build-hub.ts stages
   * into the release. Do not substitute the release's own `bundleHash` here —
   * that identifies the hub bundle, never matches what an agent reports, and
   * makes every agent install/update fail its health check.
   */
  getBundleHash(): string {
    const tarball = this.getTarballPath();
    const stat = fs.statSync(tarball);
    if (
      this.cachedBundleHash &&
      this.cachedBundleHash.tarballMtimeMs === stat.mtimeMs &&
      this.cachedBundleHash.tarballSize === stat.size
    ) {
      return this.cachedBundleHash.hash;
    }

    const hash = fs.readFileSync(path.join(getDistDir(), 'bundle-hash.txt'), 'utf-8').trim();
    this.cachedBundleHash = { tarballMtimeMs: stat.mtimeMs, tarballSize: stat.size, hash };
    return hash;
  }

  getBundleHashIfBuilt(): string | null {
    try {
      return this.getBundleHash();
    } catch {
      return null;
    }
  }

  getSha256sumsPath(): string {
    return path.join(getDistDir(), 'SHA256SUMS');
  }

  needsBuild(): boolean {
    if (isReleaseMode()) return false;
    const dist = getDistDir();
    if (!fs.existsSync(path.join(dist, 'azito-agent.tar.gz'))) return true;
    if (!fs.existsSync(path.join(dist, 'bundle-hash.txt'))) return true;
    if (!fs.existsSync(path.join(dist, 'SHA256SUMS'))) return true;
    return this.getBundledSha() !== this.getHubSha();
  }

  async ensureBuild(): Promise<void> {
    if (!this.needsBuild()) return;
    console.log('[AgentBundler] Building agent bundle...');
    // The node binary itself loads tsx: `npx` is `npx.cmd` on Windows and cannot be run without a shell.
    // The agent is always the Linux x86-64 one; a hub of another OS / CPU builds it with a Linux node-pty that
    // AZITO_AGENT_NODE_PTY_LINUX names (the child inherits the environment, and build-agent.ts says what it needs).
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-agent.ts'], {
        cwd: SERVER_ROOT,
        stdio: 'inherit',
        timeout: 180000,
      });
    } catch (err) {
      throw new Error(
        'Building the agent bundle failed (build-agent.ts printed why to the hub log). ' +
          'A hub that is not Linux x86-64 needs AZITO_AGENT_NODE_PTY_LINUX set to a node-pty folder built on Linux x86-64; ' +
          `a release hub carries a ready bundle. (${(err as Error).message})`,
      );
    }
  }
}
