import { execSync } from 'child_process';
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
    return execSync('git rev-parse --short HEAD', { cwd: SERVER_ROOT, timeout: 5000 })
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
    execSync('npx tsx scripts/build-agent.ts', {
      cwd: SERVER_ROOT,
      stdio: 'inherit',
      timeout: 180000,
    });
  }
}
