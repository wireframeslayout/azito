import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isReleaseMode, getReleaseInfo, getBundleRoot } from '../../../shared/releaseInfo';
import { listAgentBundleLinuxArches, type LinuxAgentArch } from './agentBundleCheck';

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

interface CachedLinuxArches {
  tarballMtimeMs: number;
  tarballSize: number;
  arches: LinuxAgentArch[];
}

export class AgentBundler {
  private cachedBundleHash: CachedBundleHash | null = null;
  private cachedLinuxArches: CachedLinuxArches | null = null;

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

  /** The Linux architectures the built tarball carries a node-pty for (a source hub may build without arm64). */
  getLinuxArches(): LinuxAgentArch[] {
    const tarball = this.getTarballPath();
    const stat = fs.statSync(tarball);
    if (this.cachedLinuxArches?.tarballMtimeMs === stat.mtimeMs && this.cachedLinuxArches.tarballSize === stat.size) return this.cachedLinuxArches.arches;
    const arches = listAgentBundleLinuxArches(fs.readFileSync(tarball));
    this.cachedLinuxArches = { tarballMtimeMs: stat.mtimeMs, tarballSize: stat.size, arches };
    return arches;
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
    // The child inherits both Linux native inputs and reports a missing or mismatched architecture. A source hub without an
    // arm64 node-pty still builds (x64 agents only); AgentInstaller refuses a Linux arm64 host for such a bundle.
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/build-agent.ts', '--allow-missing-linux-arm64'], {
        cwd: SERVER_ROOT,
        stdio: 'inherit',
        timeout: 180000,
      });
    } catch (err) {
      throw new Error(
        'Building the agent bundle failed (build-agent.ts printed why to the hub log). ' +
          'A hub that is not Linux x64 needs AZITO_AGENT_NODE_PTY_LINUX set to a node-pty folder built on Linux x64 (AZITO_AGENT_NODE_PTY_LINUX_ARM64 adds Linux arm64 agents); ' +
          `a release hub carries a ready bundle. (${(err as Error).message})`,
      );
    }
  }
}
