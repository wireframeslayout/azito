import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { isReleaseMode } from '../../shared/releaseInfo';
import type { ServiceManager } from './serviceControl';

export type DeployMode = 'systemd' | 'launchd' | 'source';

const LAUNCHD_PLIST_PATH = path.join('Library', 'LaunchAgents', 'com.azito.hub.plist');

/**
 * Detects how the hub was launched, to decide whether an in-app "run system
 * update" flow is available:
 *  - source: running from a git checkout (not a release bundle) — nothing to
 *    switch, the operator must `git pull` themselves.
 *  - launchd: macOS release install managed by a per-user LaunchAgent.
 *  - systemd: Linux release install managed by `systemctl --user`.
 *
 * Both service-managed modes support the update flow; 'source' does not,
 * because there is no service to restart into the new version.
 */
export class DeployModeDetector {
  // How the hub was launched can't change while this process is alive, but
  // detecting it (isSystemdUnitActive) spawns a blocking subprocess — cache
  // after the first call so GET /api/health (polled by uptime monitors) and
  // GET /api/system/update/status don't re-spawn `systemctl` on every request.
  private cached: DeployMode | null = null;

  detect(): DeployMode {
    if (this.cached) return this.cached;
    this.cached = this.detectUncached();
    return this.cached;
  }

  private detectUncached(): DeployMode {
    if (!isReleaseMode()) return 'source';

    if (process.platform === 'darwin') {
      const plistPath = path.join(os.homedir(), LAUNCHD_PLIST_PATH);
      if (fs.existsSync(plistPath)) return 'launchd';
    }

    if (this.isSystemdUnitActive()) return 'systemd';

    return 'source';
  }

  canUpdate(): boolean {
    return this.detect() !== 'source';
  }

  /** The service manager to restart through, or null when there is none. */
  serviceManager(): ServiceManager | null {
    const mode = this.detect();
    return mode === 'source' ? null : mode;
  }

  getDisabledReason(): string | null {
    const mode = this.detect();
    if (mode === 'source') {
      // 'source' covers two situations: a git checkout, and a release bundle
      // started by hand instead of through a service manager. Telling the
      // latter to run `git pull` would be nonsense — there is no repository.
      if (isReleaseMode()) {
        return 'サービスとして登録されていないため、画面からは更新できません。install.sh でサービスを設定するか、手動で tarball を展開して current を切り替えてください';
      }
      return '開発モードで起動中のため、画面からは更新できません。ターミナルで git pull を実行してください';
    }
    return null;
  }

  private isSystemdUnitActive(): boolean {
    try {
      execFileSync('systemctl', ['--user', 'is-active', 'azito'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}
